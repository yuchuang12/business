package agentruntime

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// PostgresRuntimeStore persists the production-only operations required by
// durable workers. It is intentionally separate from InMemoryRuntimeStore,
// which remains a deterministic fixture for unit tests.
type PostgresRuntimeStore struct {
	db *sql.DB
}

var _ ProductionRuntimeStore = (*PostgresRuntimeStore)(nil)

// OperationalAuditQuery is scoped to the trusted context's tenant and trace.
// CorrelationID narrows provider-effect events without exposing payloads.
type OperationalAuditQuery struct {
	CorrelationID string
	Limit         int
}

// OperationalAuditEvent is the payload-free event shape used by operators to
// diagnose one tenant-scoped trace.
type OperationalAuditEvent struct {
	AuditID       string
	TenantID      string
	TraceID       string
	CorrelationID string
	ActorID       string
	Action        string
	TargetType    string
	TargetID      string
	Outcome       string
	CreatedAt     time.Time
}

func NewPostgresRuntimeStore(db *sql.DB) (*PostgresRuntimeStore, error) {
	if db == nil {
		return nil, errors.New("postgres DB is required")
	}
	return &PostgresRuntimeStore{db: db}, nil
}

func (store *PostgresRuntimeStore) ClaimIdempotency(scope, requestHash, targetID string) (string, bool, error) {
	tenantID, _, ok := strings.Cut(scope, ":")
	if !ok || !opaqueID.MatchString(tenantID) || requestHash == "" || targetID == "" {
		return "", false, runtimeError("RUNTIME_VALIDATION", "Idempotency claim is invalid.")
	}

	ctx := context.Background()
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return "", false, fmt.Errorf("begin idempotency claim: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	result, err := tx.ExecContext(ctx, `
		INSERT INTO agent_runtime_idempotency (tenant_id, scope, request_hash, target_id, expires_at)
		VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP + INTERVAL '24 hours')
		ON CONFLICT (tenant_id, scope) DO NOTHING`,
		tenantID, scope, requestHash, targetID)
	if err != nil {
		return "", false, fmt.Errorf("insert idempotency claim: %w", err)
	}
	if inserted, err := result.RowsAffected(); err != nil {
		return "", false, fmt.Errorf("read idempotency claim: %w", err)
	} else if inserted == 1 {
		if err := tx.Commit(); err != nil {
			return "", false, fmt.Errorf("commit idempotency claim: %w", err)
		}
		return "", false, nil
	}
	var existingID, existingHash string
	if err := tx.QueryRowContext(ctx, `
		SELECT target_id, request_hash FROM agent_runtime_idempotency
		WHERE tenant_id = $1 AND scope = $2 FOR UPDATE`, tenantID, scope).Scan(&existingID, &existingHash); err != nil {
		return "", false, fmt.Errorf("read idempotency claim: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return "", false, fmt.Errorf("commit idempotency claim: %w", err)
	}
	return existingID, existingHash != requestHash, nil
}

// QueryOperationalAudit returns redacted lifecycle and provider-effect events
// for exactly the caller's trusted tenant and trace.
func (store *PostgresRuntimeStore) QueryOperationalAudit(tenant TenantContext, query OperationalAuditQuery) ([]OperationalAuditEvent, error) {
	tenant, err := ValidateTenantContext(tenant)
	if err != nil {
		return nil, err
	}
	if query.Limit == 0 {
		query.Limit = 100
	}
	if query.Limit < 1 || query.Limit > 500 || (query.CorrelationID != "" && !nameID.MatchString(query.CorrelationID)) {
		return nil, runtimeError("RUNTIME_VALIDATION", "Operational audit query is invalid.")
	}
	rows, err := store.db.QueryContext(context.Background(), `
		SELECT audit_id, tenant_id, trace_id, correlation_id, actor_id, action, target_type, target_id, outcome, created_at
		FROM (
			SELECT audit_id, tenant_id, trace_id, '' AS correlation_id, actor_id, action, target_type, target_id, outcome, created_at
			FROM agent_runtime_audit_refs
			WHERE tenant_id = $1 AND trace_id = $2 AND $3 = ''
			UNION ALL
			SELECT audit_id, tenant_id, trace_id, correlation_id, actor_id, 'provider_effect.reconcile', 'provider_effect',
				effect_id, COALESCE(reconciliation_state, 'pending'), created_at
			FROM provider_effects
			WHERE tenant_id = $1 AND trace_id = $2 AND ($3 = '' OR correlation_id = $3)
		) events
		ORDER BY created_at DESC
		LIMIT $4`, tenant.TenantID, tenant.TraceID, query.CorrelationID, query.Limit)
	if err != nil {
		return nil, fmt.Errorf("query operational audit: %w", err)
	}
	defer rows.Close()
	events := []OperationalAuditEvent{}
	for rows.Next() {
		var event OperationalAuditEvent
		if err := rows.Scan(&event.AuditID, &event.TenantID, &event.TraceID, &event.CorrelationID, &event.ActorID, &event.Action, &event.TargetType, &event.TargetID, &event.Outcome, &event.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan operational audit: %w", err)
		}
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate operational audit: %w", err)
	}
	return events, nil
}

func (store *PostgresRuntimeStore) ClaimRecoverableWork(tenantID string, limit int) ([]string, error) {
	if !opaqueID.MatchString(tenantID) || limit < 1 {
		return nil, runtimeError("RUNTIME_VALIDATION", "Recovery claim is invalid.")
	}
	ctx := context.Background()
	rows, err := store.db.QueryContext(ctx, `
		WITH candidates AS (
			SELECT agent_run_id AS id FROM agent_runs
			WHERE tenant_id = $1 AND status = 'running'
			  AND (recovery_claim_until IS NULL OR recovery_claim_until < CURRENT_TIMESTAMP)
			ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT $2
		)
		UPDATE agent_runs r SET recovery_claim_until = CURRENT_TIMESTAMP + INTERVAL '30 seconds'
		FROM candidates WHERE r.agent_run_id = candidates.id RETURNING r.agent_run_id`,
		tenantID, limit)
	if err != nil {
		return nil, fmt.Errorf("claim recoverable runs: %w", err)
	}
	defer rows.Close()
	claimed := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan recoverable run: %w", err)
		}
		claimed = append(claimed, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate recoverable runs: %w", err)
	}
	return claimed, nil
}

func (store *PostgresRuntimeStore) ClaimProviderEffect(ctx TenantContext, effect ProviderEffectBinding) (ProviderEffectClaim, error) {
	if err := effect.ValidateForContext(ctx); err != nil {
		return ProviderEffectClaim{}, err
	}
	effect.ReconcileBy = effect.ReconcileBy.UTC().Round(time.Microsecond)
	tx, err := store.db.BeginTx(context.Background(), nil)
	if err != nil {
		return ProviderEffectClaim{}, fmt.Errorf("begin provider effect claim: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	result, err := tx.ExecContext(context.Background(), `
		INSERT INTO provider_effects (
			effect_id, contract_version, agent_run_id, tool_execution_id, attempt, tenant_id, actor_id, actor_type,
			tool_name, tool_version, idempotency_key, canonical_request_hash, approval_request_id, approval_input_hash,
			trace_id, audit_id, correlation_id, reconcile_by
		) VALUES (
			$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NULLIF($13, ''), NULLIF($14, ''),
			$15, $16, $17, $18
		) ON CONFLICT (effect_id) DO NOTHING`,
		effect.EffectID, effect.ContractVersion, effect.AgentRunID, effect.ToolExecutionID, effect.Attempt,
		effect.TenantID, effect.ActorID, effect.ActorType, effect.ToolName, effect.ToolVersion, effect.IdempotencyKey,
		effect.CanonicalRequestHash, effect.ApprovalRequestID, effect.ApprovalInputHash, effect.TraceID, effect.AuditID,
		effect.CorrelationID, effect.ReconcileBy)
	if err != nil {
		return ProviderEffectClaim{}, fmt.Errorf("insert provider effect: %w", err)
	}
	inserted, err := result.RowsAffected()
	if err != nil {
		return ProviderEffectClaim{}, fmt.Errorf("read provider effect claim: %w", err)
	}
	if inserted == 1 {
		if err := tx.Commit(); err != nil {
			return ProviderEffectClaim{}, fmt.Errorf("commit provider effect claim: %w", err)
		}
		return ProviderEffectClaim{EffectID: effect.EffectID, CanonicalRequestHash: effect.CanonicalRequestHash}, nil
	}
	var matches bool
	if err := tx.QueryRowContext(context.Background(), `
		SELECT EXISTS (
			SELECT 1 FROM provider_effects WHERE effect_id = $1
			AND contract_version = $2 AND agent_run_id = $3 AND tool_execution_id = $4 AND attempt = $5
			AND tenant_id = $6 AND actor_id = $7 AND actor_type = $8 AND tool_name = $9 AND tool_version = $10
			AND idempotency_key = $11 AND canonical_request_hash = $12
			AND approval_request_id IS NOT DISTINCT FROM NULLIF($13, '')
			AND approval_input_hash IS NOT DISTINCT FROM NULLIF($14, '')
			AND trace_id = $15 AND audit_id = $16 AND correlation_id = $17 AND reconcile_by = $18
		)`,
		effect.EffectID, effect.ContractVersion, effect.AgentRunID, effect.ToolExecutionID, effect.Attempt,
		effect.TenantID, effect.ActorID, effect.ActorType, effect.ToolName, effect.ToolVersion, effect.IdempotencyKey,
		effect.CanonicalRequestHash, effect.ApprovalRequestID, effect.ApprovalInputHash, effect.TraceID, effect.AuditID,
		effect.CorrelationID, effect.ReconcileBy).Scan(&matches); err != nil {
		return ProviderEffectClaim{}, fmt.Errorf("read provider effect: %w", err)
	}
	if !matches {
		return ProviderEffectClaim{}, runtimeError("RUNTIME_CONFLICT", "Provider effect identity is bound to a different request.")
	}
	if err := tx.Commit(); err != nil {
		return ProviderEffectClaim{}, fmt.Errorf("commit provider effect claim: %w", err)
	}
	return ProviderEffectClaim{Existing: true, EffectID: effect.EffectID, CanonicalRequestHash: effect.CanonicalRequestHash}, nil
}

func (store *PostgresRuntimeStore) ReconcileProviderEffect(ctx TenantContext, effect ProviderEffectBinding) (ProviderEffectReconciliation, error) {
	if err := effect.ValidateForContext(ctx); err != nil {
		return ProviderEffectReconciliation{}, err
	}
	var result ProviderEffectReconciliation
	var state sql.NullString
	var providerReference, failureCode sql.NullString
	var observedAt sql.NullTime
	var retryAfter sql.NullTime
	err := store.db.QueryRowContext(context.Background(), `
		SELECT reconciliation_state, provider_reference, observed_at, retry_after, failure_code
		FROM provider_effects
		WHERE effect_id = $1 AND tenant_id = $2 AND canonical_request_hash = $3`,
		effect.EffectID, ctx.TenantID, effect.CanonicalRequestHash).
		Scan(&state, &providerReference, &observedAt, &retryAfter, &failureCode)
	if errors.Is(err, sql.ErrNoRows) {
		return ProviderEffectReconciliation{State: ProviderEffectUnknown, ObservedAt: time.Now().UTC()}, nil
	}
	if err != nil {
		return ProviderEffectReconciliation{}, fmt.Errorf("read provider reconciliation: %w", err)
	}
	if !state.Valid {
		return ProviderEffectReconciliation{State: ProviderEffectUnknown, ObservedAt: time.Now().UTC()}, nil
	}
	result = ProviderEffectReconciliation{
		State: ProviderEffectState(state.String), ProviderReference: providerReference.String,
		ObservedAt: observedAt.Time, FailureCode: failureCode.String,
	}
	if retryAfter.Valid {
		result.RetryAfter = &retryAfter.Time
	}
	if err := result.Validate(); err != nil {
		return ProviderEffectReconciliation{}, err
	}
	return result, nil
}

func (store *PostgresRuntimeStore) RecordProviderEffect(ctx TenantContext, effect ProviderEffectBinding, result ProviderEffectReconciliation) error {
	if err := effect.ValidateForContext(ctx); err != nil {
		return err
	}
	if err := result.Validate(); err != nil {
		return err
	}
	update, err := store.db.ExecContext(context.Background(), `
		UPDATE provider_effects SET reconciliation_state = $1, provider_reference = NULLIF($2, ''),
			observed_at = $3, retry_after = $4, failure_code = NULLIF($5, '')
		WHERE effect_id = $6 AND tenant_id = $7 AND canonical_request_hash = $8`,
		result.State, result.ProviderReference, result.ObservedAt, result.RetryAfter, result.FailureCode,
		effect.EffectID, ctx.TenantID, effect.CanonicalRequestHash)
	if err != nil {
		return fmt.Errorf("record provider reconciliation: %w", err)
	}
	count, err := update.RowsAffected()
	if err != nil {
		return fmt.Errorf("read provider reconciliation write: %w", err)
	}
	if count != 1 {
		return runtimeError("RUNTIME_NOT_FOUND", "Provider effect is not visible in this tenant.")
	}
	return nil
}
