package agentruntime

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
)

// ProductionAgentRuntimeService is the PostgreSQL-backed runtime composition
// boundary. Unlike AgentRuntimeService, it never selects an in-memory store.
type ProductionAgentRuntimeService struct {
	Store                  *PostgresRuntimeStore
	ApprovalValidator      ApprovalValidator
	AuthorizationValidator AuthorizationValidator
	Observer               RuntimeObserver
}

// NewProductionAgentRuntimeService constructs the durable runtime service.
// Call Migrate before constructing the service during application startup.
func NewProductionAgentRuntimeService(store *PostgresRuntimeStore, approval ApprovalValidator, authorization AuthorizationValidator) (*ProductionAgentRuntimeService, error) {
	return NewProductionAgentRuntimeServiceWithObserver(store, approval, authorization, SlogRuntimeObserver{})
}

// NewProductionAgentRuntimeServiceWithObserver constructs a durable service
// with a caller-provided observability sink.
func NewProductionAgentRuntimeServiceWithObserver(store *PostgresRuntimeStore, approval ApprovalValidator, authorization AuthorizationValidator, observer RuntimeObserver) (*ProductionAgentRuntimeService, error) {
	if store == nil {
		return nil, errors.New("postgres runtime store is required")
	}
	if approval == nil {
		approval = func(TenantContext, ApprovalBinding) bool { return true }
	}
	if authorization == nil {
		authorization = func(TenantContext, string) bool { return true }
	}
	return &ProductionAgentRuntimeService{Store: store, ApprovalValidator: approval, AuthorizationValidator: authorization, Observer: observer}, nil
}

func (service *ProductionAgentRuntimeService) CreateRun(tenant TenantContext, options CreateRunOptions) (AgentRun, bool, error) {
	tenant, err := ValidateTenantContext(tenant)
	if err != nil {
		return AgentRun{}, false, err
	}
	if options.AgentType == "" {
		options.AgentType = "merchant"
	}
	if options.MaxRetries == 0 && !options.MaxRetriesSet {
		options.MaxRetries = 3
	}
	if options.AgentType != "merchant" && options.AgentType != "customer" && options.AgentType != "system" {
		return AgentRun{}, false, runtimeError("RUNTIME_VALIDATION", "Invalid agent type.")
	}
	if options.WorkflowInstanceID != "" {
		if err := ensureID(options.WorkflowInstanceID); err != nil {
			return AgentRun{}, false, err
		}
	}
	now := mustTime()
	run := AgentRun{
		ContractVersion: ContractVersion, AgentRunID: generatedID("run"), TenantID: tenant.TenantID,
		ActorID: tenant.ActorID, TraceID: tenant.TraceID, WorkflowInstanceID: options.WorkflowInstanceID,
		AgentType: options.AgentType, Status: "queued", CreatedAt: now, UpdatedAt: now, Attempt: 1,
		Retry: defaultRetry(options.MaxRetries), Accounting: defaultAccounting(), AuditID: generatedID("audit"),
	}
	requestHash := canonicalRequestHash(tenant, map[string]any{
		"agent_type": options.AgentType, "workflow_instance_id": options.WorkflowInstanceID, "max_retries": options.MaxRetries,
	})
	result, duplicate, err := service.Store.createRun(tenant, run, options.IdempotencyKey, requestHash)
	service.observe(tenant, RuntimeEvent{Operation: "agent_run.create", Outcome: outcome(err), AgentRunID: result.AgentRunID, ErrorCode: ErrorCode(err)})
	return result, duplicate, err
}

func (service *ProductionAgentRuntimeService) CreateToolExecution(tenant TenantContext, options CreateToolOptions) (ToolExecution, bool, error) {
	tenant, err := ValidateTenantContext(tenant)
	if err != nil {
		return ToolExecution{}, false, err
	}
	if options.ToolVersion == "" {
		options.ToolVersion = ContractVersion
	}
	if options.MaxRetries == 0 && !options.MaxRetriesSet {
		options.MaxRetries = 3
	}
	if !nameID.MatchString(options.ToolName) || !version.MatchString(options.ToolVersion) || len(options.IdempotencyKey) < 16 || !nameID.MatchString(options.IdempotencyKey) {
		return ToolExecution{}, false, runtimeError("RUNTIME_VALIDATION", "Tool name and idempotency key are required.")
	}
	now := mustTime()
	tool := ToolExecution{
		ContractVersion: ContractVersion, ToolExecutionID: generatedID("exec"), AgentRunID: options.AgentRunID,
		TenantID: tenant.TenantID, ActorID: tenant.ActorID, TraceID: tenant.TraceID, ToolName: options.ToolName,
		ToolVersion: options.ToolVersion, IdempotencyKey: options.IdempotencyKey, Status: "queued",
		CreatedAt: now, UpdatedAt: now, Attempt: 1, Retry: defaultRetry(options.MaxRetries),
		Accounting: defaultAccounting(), AuditID: generatedID("audit"),
	}
	requestHash := canonicalRequestHash(tenant, map[string]any{
		"agent_run_id": options.AgentRunID, "tool_name": options.ToolName, "tool_version": options.ToolVersion, "input": options.CanonicalInput,
	})
	result, duplicate, err := service.Store.createTool(tenant, tool, requestHash)
	service.observe(tenant, RuntimeEvent{Operation: "tool_execution.create", Outcome: outcome(err), AgentRunID: tool.AgentRunID, ToolExecutionID: result.ToolExecutionID, ErrorCode: ErrorCode(err)})
	return result, duplicate, err
}

func (service *ProductionAgentRuntimeService) Run(tenant TenantContext, id string) (AgentRun, error) {
	tenant, err := ValidateTenantContext(tenant)
	if err != nil {
		return AgentRun{}, err
	}
	return service.Store.run(tenant, id)
}

func (service *ProductionAgentRuntimeService) Tool(tenant TenantContext, id string) (ToolExecution, error) {
	tenant, err := ValidateTenantContext(tenant)
	if err != nil {
		return ToolExecution{}, err
	}
	return service.Store.tool(tenant, id)
}

func (service *ProductionAgentRuntimeService) TransitionRun(tenant TenantContext, id, to, approval string) (AgentRun, error) {
	tenant, err := ValidateTenantContext(tenant)
	if err != nil {
		return AgentRun{}, err
	}
	result, err := service.Store.transitionRun(tenant, id, to, approval)
	service.observe(tenant, RuntimeEvent{Operation: "agent_run.transition", Outcome: outcome(err), AgentRunID: id, ApprovalID: approval, ErrorCode: ErrorCode(err)})
	return result, err
}

func (service *ProductionAgentRuntimeService) TransitionTool(tenant TenantContext, id, to, approval string) (ToolExecution, error) {
	tenant, err := ValidateTenantContext(tenant)
	if err != nil {
		return ToolExecution{}, err
	}
	result, err := service.Store.transitionTool(tenant, id, to, approval)
	service.observe(tenant, RuntimeEvent{Operation: "tool_execution.transition", Outcome: outcome(err), AgentRunID: result.AgentRunID, ToolExecutionID: id, ApprovalID: approval, ErrorCode: ErrorCode(err)})
	return result, err
}

// Recover claims persisted running work and fails any tool with an unresolved
// provider effect; unknown effects must be reconciled before another attempt.
func (service *ProductionAgentRuntimeService) Recover(tenant TenantContext) ([]string, error) {
	tenant, err := ValidateTenantContext(tenant)
	if err != nil {
		return nil, err
	}
	ids, err := service.Store.ClaimRecoverableWork(tenant.TenantID, 100)
	if err != nil {
		return nil, err
	}
	recovered := make([]string, 0, len(ids))
	for _, id := range ids {
		if err := service.Store.recoverRun(tenant, id); err != nil {
			service.observe(tenant, RuntimeEvent{Operation: "runtime.recover", Outcome: "rejected", AgentRunID: id, ErrorCode: ErrorCode(err)})
			return nil, err
		}
		run, runErr := service.Store.run(tenant, id)
		event := RuntimeEvent{Operation: "runtime.recover", Outcome: "accepted", AgentRunID: id}
		if runErr == nil && run.Failure != nil {
			event.ErrorCode = run.Failure.Code
		}
		service.observe(tenant, event)
		recovered = append(recovered, id)
	}
	return recovered, nil
}

// ClaimProviderEffect binds an external side effect to persisted execution
// identity before dispatching it to a provider.
func (service *ProductionAgentRuntimeService) ClaimProviderEffect(tenant TenantContext, effect ProviderEffectBinding) (ProviderEffectClaim, error) {
	tenant, err := ValidateTenantContext(tenant)
	if err != nil {
		return ProviderEffectClaim{}, err
	}
	result, err := service.Store.ClaimProviderEffect(tenant, effect)
	service.observe(tenant, RuntimeEvent{Operation: "provider_effect.claim", Outcome: outcome(err), CorrelationID: effect.CorrelationID, AgentRunID: effect.AgentRunID, ToolExecutionID: effect.ToolExecutionID, ApprovalID: effect.ApprovalRequestID, ErrorCode: ErrorCode(err)})
	return result, err
}

// ReconcileProviderEffect returns unknown_in_flight unless the persisted
// provider observation proves that a retry is safe.
func (service *ProductionAgentRuntimeService) ReconcileProviderEffect(tenant TenantContext, effect ProviderEffectBinding) (ProviderEffectReconciliation, error) {
	tenant, err := ValidateTenantContext(tenant)
	if err != nil {
		return ProviderEffectReconciliation{}, err
	}
	result, err := service.Store.ReconcileProviderEffect(tenant, effect)
	service.observe(tenant, RuntimeEvent{Operation: "provider_effect.reconcile", Outcome: outcome(err), CorrelationID: effect.CorrelationID, AgentRunID: effect.AgentRunID, ToolExecutionID: effect.ToolExecutionID, ProviderState: result.State, ErrorCode: ErrorCode(err)})
	return result, err
}

func (service *ProductionAgentRuntimeService) RecordProviderEffect(tenant TenantContext, effect ProviderEffectBinding, result ProviderEffectReconciliation) error {
	tenant, err := ValidateTenantContext(tenant)
	if err != nil {
		return err
	}
	err = service.Store.RecordProviderEffect(tenant, effect, result)
	service.observe(tenant, RuntimeEvent{Operation: "provider_effect.record", Outcome: outcome(err), CorrelationID: effect.CorrelationID, AgentRunID: effect.AgentRunID, ToolExecutionID: effect.ToolExecutionID, ProviderState: result.State, ErrorCode: ErrorCode(err)})
	return err
}

func (service *ProductionAgentRuntimeService) observe(tenant TenantContext, event RuntimeEvent) {
	if service.Observer == nil {
		return
	}
	event.Timestamp = mustTime()
	event.TenantID = tenant.TenantID
	event.TraceID = tenant.TraceID
	service.Observer.RecordRuntimeEvent(event)
}

func outcome(err error) string {
	if err != nil {
		return "rejected"
	}
	return "accepted"
}

func (store *PostgresRuntimeStore) createRun(tenant TenantContext, run AgentRun, key, requestHash string) (AgentRun, bool, error) {
	tx, err := store.db.BeginTx(context.Background(), nil)
	if err != nil {
		return AgentRun{}, false, fmt.Errorf("begin run creation: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if key != "" {
		scope := tenant.TenantID + ":agent-run:" + key
		var id, hash string
		if err := tx.QueryRow(`SELECT target_id, request_hash FROM agent_runtime_idempotency WHERE tenant_id = $1 AND scope = $2 FOR UPDATE`, tenant.TenantID, scope).Scan(&id, &hash); err == nil {
			if hash != requestHash {
				return AgentRun{}, false, runtimeError("RUNTIME_CONFLICT", "Idempotency key is bound to a different request.")
			}
			existing, err := scanAgentRun(tx.QueryRow(`SELECT `+runColumns+` FROM agent_runs WHERE agent_run_id = $1`, id))
			return existing, true, err
		} else if !errors.Is(err, sql.ErrNoRows) {
			return AgentRun{}, false, fmt.Errorf("read run idempotency: %w", err)
		}
		if _, err := tx.Exec(`INSERT INTO agent_runtime_idempotency (tenant_id, scope, request_hash, target_id, expires_at) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP + INTERVAL '24 hours')`, tenant.TenantID, scope, requestHash, run.AgentRunID); err != nil {
			return AgentRun{}, false, fmt.Errorf("claim run idempotency: %w", err)
		}
	}
	if err := insertRun(tx, run); err != nil {
		return AgentRun{}, false, err
	}
	if err := insertAudit(tx, tenant, run.AuditID, "run.create", "agent_run", run.AgentRunID, "accepted"); err != nil {
		return AgentRun{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return AgentRun{}, false, fmt.Errorf("commit run creation: %w", err)
	}
	return run, false, nil
}

func (store *PostgresRuntimeStore) createTool(tenant TenantContext, tool ToolExecution, requestHash string) (ToolExecution, bool, error) {
	tx, err := store.db.BeginTx(context.Background(), nil)
	if err != nil {
		return ToolExecution{}, false, fmt.Errorf("begin tool creation: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	run, err := scanAgentRun(tx.QueryRow(`SELECT `+runColumns+` FROM agent_runs WHERE agent_run_id = $1 AND tenant_id = $2 AND actor_id = $3 AND trace_id = $4 FOR UPDATE`, tool.AgentRunID, tenant.TenantID, tenant.ActorID, tenant.TraceID))
	if errors.Is(err, sql.ErrNoRows) {
		return ToolExecution{}, false, runtimeError("RUNTIME_NOT_FOUND", "AgentRun is not visible in this tenant.")
	}
	if err != nil {
		return ToolExecution{}, false, err
	}
	if runTerminal(run.Status) {
		return ToolExecution{}, false, runtimeError("RUNTIME_CONFLICT", "Cannot add work to a terminal AgentRun.")
	}
	tool.WorkflowInstanceID = run.WorkflowInstanceID
	var existingID, existingHash string
	err = tx.QueryRow(`SELECT target_id, request_hash FROM agent_runtime_idempotency WHERE tenant_id = $1 AND scope = $2 FOR UPDATE`, tenant.TenantID, fmtScope(tenant.TenantID, tool.ToolName, tool.ToolVersion, tool.IdempotencyKey)).Scan(&existingID, &existingHash)
	if err == nil {
		if existingHash != requestHash {
			return ToolExecution{}, false, runtimeError("RUNTIME_CONFLICT", "Idempotency key is bound to a different request.")
		}
		existing, err := scanToolExecution(tx.QueryRow(`SELECT `+toolColumns+` FROM tool_executions WHERE tool_execution_id = $1`, existingID))
		return existing, true, err
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return ToolExecution{}, false, err
	}
	scope := fmtScope(tenant.TenantID, tool.ToolName, tool.ToolVersion, tool.IdempotencyKey)
	if _, err := tx.Exec(`INSERT INTO agent_runtime_idempotency (tenant_id, scope, request_hash, target_id, expires_at) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP + INTERVAL '24 hours')`, tenant.TenantID, scope, requestHash, tool.ToolExecutionID); err != nil {
		return ToolExecution{}, false, fmt.Errorf("claim tool idempotency: %w", err)
	}
	if err := insertTool(tx, tool); err != nil {
		return ToolExecution{}, false, err
	}
	if err := insertAudit(tx, tenant, tool.AuditID, "tool.create", "tool_execution", tool.ToolExecutionID, "accepted"); err != nil {
		return ToolExecution{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return ToolExecution{}, false, fmt.Errorf("commit tool creation: %w", err)
	}
	return tool, false, nil
}

func (store *PostgresRuntimeStore) run(tenant TenantContext, id string) (AgentRun, error) {
	run, err := scanAgentRun(store.db.QueryRow(`SELECT `+runColumns+` FROM agent_runs WHERE agent_run_id = $1 AND tenant_id = $2 AND actor_id = $3 AND trace_id = $4`, id, tenant.TenantID, tenant.ActorID, tenant.TraceID))
	if errors.Is(err, sql.ErrNoRows) {
		return AgentRun{}, runtimeError("RUNTIME_NOT_FOUND", "AgentRun is not visible in this tenant.")
	}
	return run, err
}

func (store *PostgresRuntimeStore) tool(tenant TenantContext, id string) (ToolExecution, error) {
	tool, err := scanToolExecution(store.db.QueryRow(`SELECT `+toolColumns+` FROM tool_executions WHERE tool_execution_id = $1 AND tenant_id = $2 AND actor_id = $3 AND trace_id = $4`, id, tenant.TenantID, tenant.ActorID, tenant.TraceID))
	if errors.Is(err, sql.ErrNoRows) {
		return ToolExecution{}, runtimeError("RUNTIME_NOT_FOUND", "ToolExecution is not visible in this tenant.")
	}
	return tool, err
}

func (store *PostgresRuntimeStore) transitionRun(tenant TenantContext, id, to, approval string) (AgentRun, error) {
	tx, err := store.db.BeginTx(context.Background(), nil)
	if err != nil {
		return AgentRun{}, err
	}
	defer func() { _ = tx.Rollback() }()
	run, err := scanAgentRun(tx.QueryRow(`SELECT `+runColumns+` FROM agent_runs WHERE agent_run_id = $1 AND tenant_id = $2 AND actor_id = $3 AND trace_id = $4 FOR UPDATE`, id, tenant.TenantID, tenant.ActorID, tenant.TraceID))
	if errors.Is(err, sql.ErrNoRows) {
		return AgentRun{}, runtimeError("RUNTIME_NOT_FOUND", "AgentRun is not visible in this tenant.")
	}
	if err != nil {
		return AgentRun{}, err
	}
	if !runTransition(run.Status, to) {
		return AgentRun{}, runtimeError("LIFECYCLE_ILLEGAL_TRANSITION", "Illegal AgentRun transition.")
	}
	if to == "waiting_approval" && !nameID.MatchString(approval) {
		return AgentRun{}, runtimeError("APPROVAL_REQUIRED", "Approval reference is required.")
	}
	now := mustTime()
	run.Status, run.UpdatedAt = to, now
	if to == "running" && run.StartedAt == nil {
		run.StartedAt = &now
	}
	if runTerminal(to) {
		run.EndedAt = &now
	}
	if approval != "" {
		run.ApprovalRequestID = approval
	}
	if err := updateRun(tx, run); err != nil {
		return AgentRun{}, err
	}
	if err := insertAudit(tx, tenant, generatedID("audit"), "lifecycle.transition", "agent_run", id, "accepted"); err != nil {
		return AgentRun{}, err
	}
	if err := tx.Commit(); err != nil {
		return AgentRun{}, err
	}
	return run, nil
}

func (store *PostgresRuntimeStore) transitionTool(tenant TenantContext, id, to, approval string) (ToolExecution, error) {
	tx, err := store.db.BeginTx(context.Background(), nil)
	if err != nil {
		return ToolExecution{}, err
	}
	defer func() { _ = tx.Rollback() }()
	tool, err := scanToolExecution(tx.QueryRow(`SELECT `+toolColumns+` FROM tool_executions WHERE tool_execution_id = $1 AND tenant_id = $2 AND actor_id = $3 AND trace_id = $4 FOR UPDATE`, id, tenant.TenantID, tenant.ActorID, tenant.TraceID))
	if errors.Is(err, sql.ErrNoRows) {
		return ToolExecution{}, runtimeError("RUNTIME_NOT_FOUND", "ToolExecution is not visible in this tenant.")
	}
	if err != nil {
		return ToolExecution{}, err
	}
	if !toolTransition(tool.Status, to) {
		return ToolExecution{}, runtimeError("LIFECYCLE_ILLEGAL_TRANSITION", "Illegal ToolExecution transition.")
	}
	if to == "waiting_approval" && !nameID.MatchString(approval) {
		return ToolExecution{}, runtimeError("APPROVAL_REQUIRED", "Approval reference is required.")
	}
	now := mustTime()
	tool.Status, tool.UpdatedAt = to, now
	if to == "running" && tool.StartedAt == nil {
		tool.StartedAt = &now
	}
	if toolTerminal(to) {
		tool.EndedAt = &now
	}
	if approval != "" {
		tool.ApprovalRequestID = approval
	}
	if err := updateTool(tx, tool); err != nil {
		return ToolExecution{}, err
	}
	if err := insertAudit(tx, tenant, generatedID("audit"), "lifecycle.transition", "tool_execution", id, "accepted"); err != nil {
		return ToolExecution{}, err
	}
	if err := tx.Commit(); err != nil {
		return ToolExecution{}, err
	}
	return tool, nil
}

func (store *PostgresRuntimeStore) recoverRun(tenant TenantContext, id string) error {
	tx, err := store.db.BeginTx(context.Background(), nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	run, err := scanAgentRun(tx.QueryRow(`SELECT `+runColumns+` FROM agent_runs WHERE agent_run_id = $1 AND tenant_id = $2 AND actor_id = $3 AND trace_id = $4 FOR UPDATE`, id, tenant.TenantID, tenant.ActorID, tenant.TraceID))
	if err != nil {
		return err
	}
	var unresolved bool
	if err := tx.QueryRow(`SELECT EXISTS (SELECT 1 FROM provider_effects WHERE agent_run_id = $1 AND tenant_id = $2 AND (reconciliation_state IS NULL OR reconciliation_state = 'unknown_in_flight'))`, id, tenant.TenantID).Scan(&unresolved); err != nil {
		return err
	}
	now := mustTime()
	run.UpdatedAt = now
	run.Status, run.EndedAt = "failed", &now
	code := "RUNTIME_WORKER_RESTART"
	if unresolved {
		code = "RUNTIME_UNKNOWN_IN_FLIGHT_EFFECT"
	}
	run.Failure = &Failure{Category: "transient_infrastructure", Code: code, Message: "Execution stopped during worker recovery."}
	if err := updateRun(tx, run); err != nil {
		return err
	}
	if unresolved {
		if _, err := tx.Exec(`UPDATE tool_executions SET status = 'failed', updated_at = $1, ended_at = $1, failure = $2 WHERE agent_run_id = $3 AND tenant_id = $4 AND status = 'running'`, now, failureJSON(run.Failure), id, tenant.TenantID); err != nil {
			return err
		}
	}
	if err := insertAudit(tx, tenant, generatedID("audit"), "runtime.recover", "agent_run", id, "accepted"); err != nil {
		return err
	}
	return tx.Commit()
}

const runColumns = `agent_run_id, contract_version, tenant_id, actor_id, trace_id, COALESCE(workflow_instance_id, ''), agent_type, status, created_at, updated_at, started_at, ended_at, COALESCE(approval_request_id, ''), attempt, retry, accounting, failure, audit_id`
const toolColumns = `tool_execution_id, agent_run_id, contract_version, tenant_id, actor_id, trace_id, COALESCE((SELECT workflow_instance_id FROM agent_runs WHERE agent_run_id = tool_executions.agent_run_id), ''), tool_name, tool_version, idempotency_key, status, created_at, updated_at, started_at, ended_at, COALESCE(approval_request_id, ''), attempt, retry, accounting, failure, audit_id`

type rowScanner interface{ Scan(...any) error }

func scanAgentRun(row rowScanner) (AgentRun, error) {
	var r AgentRun
	var retry, accounting, failure []byte
	var started, ended sql.NullTime
	err := row.Scan(&r.AgentRunID, &r.ContractVersion, &r.TenantID, &r.ActorID, &r.TraceID, &r.WorkflowInstanceID, &r.AgentType, &r.Status, &r.CreatedAt, &r.UpdatedAt, &started, &ended, &r.ApprovalRequestID, &r.Attempt, &retry, &accounting, &failure, &r.AuditID)
	if err != nil {
		return AgentRun{}, err
	}
	if started.Valid {
		r.StartedAt = &started.Time
	}
	if ended.Valid {
		r.EndedAt = &ended.Time
	}
	if err := json.Unmarshal(retry, &r.Retry); err != nil {
		return AgentRun{}, fmt.Errorf("decode run retry: %w", err)
	}
	if err := json.Unmarshal(accounting, &r.Accounting); err != nil {
		return AgentRun{}, fmt.Errorf("decode run accounting: %w", err)
	}
	if len(failure) > 0 && string(failure) != "null" {
		r.Failure = &Failure{}
		if err := json.Unmarshal(failure, r.Failure); err != nil {
			return AgentRun{}, fmt.Errorf("decode run failure: %w", err)
		}
	}
	return r, nil
}

func scanToolExecution(row rowScanner) (ToolExecution, error) {
	var t ToolExecution
	var retry, accounting, failure []byte
	var started, ended sql.NullTime
	err := row.Scan(&t.ToolExecutionID, &t.AgentRunID, &t.ContractVersion, &t.TenantID, &t.ActorID, &t.TraceID, &t.WorkflowInstanceID, &t.ToolName, &t.ToolVersion, &t.IdempotencyKey, &t.Status, &t.CreatedAt, &t.UpdatedAt, &started, &ended, &t.ApprovalRequestID, &t.Attempt, &retry, &accounting, &failure, &t.AuditID)
	if err != nil {
		return ToolExecution{}, err
	}
	if started.Valid {
		t.StartedAt = &started.Time
	}
	if ended.Valid {
		t.EndedAt = &ended.Time
	}
	if err := json.Unmarshal(retry, &t.Retry); err != nil {
		return ToolExecution{}, fmt.Errorf("decode tool retry: %w", err)
	}
	if err := json.Unmarshal(accounting, &t.Accounting); err != nil {
		return ToolExecution{}, fmt.Errorf("decode tool accounting: %w", err)
	}
	if len(failure) > 0 && string(failure) != "null" {
		t.Failure = &Failure{}
		if err := json.Unmarshal(failure, t.Failure); err != nil {
			return ToolExecution{}, fmt.Errorf("decode tool failure: %w", err)
		}
	}
	return t, nil
}

func insertRun(tx *sql.Tx, r AgentRun) error {
	retry, accounting := mustJSON(r.Retry), mustJSON(r.Accounting)
	_, err := tx.Exec(`INSERT INTO agent_runs (agent_run_id, contract_version, tenant_id, actor_id, trace_id, workflow_instance_id, agent_type, status, created_at, updated_at, started_at, ended_at, approval_request_id, attempt, retry, accounting, failure, audit_id) VALUES ($1,$2,$3,$4,$5,NULLIF($6,''),$7,$8,$9,$10,$11,$12,NULLIF($13,''),$14,$15,$16,$17,$18)`, r.AgentRunID, r.ContractVersion, r.TenantID, r.ActorID, r.TraceID, r.WorkflowInstanceID, r.AgentType, r.Status, r.CreatedAt, r.UpdatedAt, r.StartedAt, r.EndedAt, r.ApprovalRequestID, r.Attempt, retry, accounting, failureJSON(r.Failure), r.AuditID)
	return err
}
func insertTool(tx *sql.Tx, t ToolExecution) error {
	_, err := tx.Exec(`INSERT INTO tool_executions (tool_execution_id, agent_run_id, contract_version, tenant_id, actor_id, trace_id, tool_name, tool_version, idempotency_key, status, created_at, updated_at, started_at, ended_at, approval_request_id, attempt, retry, accounting, failure, audit_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NULLIF($15,''),$16,$17,$18,$19,$20)`, t.ToolExecutionID, t.AgentRunID, t.ContractVersion, t.TenantID, t.ActorID, t.TraceID, t.ToolName, t.ToolVersion, t.IdempotencyKey, t.Status, t.CreatedAt, t.UpdatedAt, t.StartedAt, t.EndedAt, t.ApprovalRequestID, t.Attempt, mustJSON(t.Retry), mustJSON(t.Accounting), failureJSON(t.Failure), t.AuditID)
	return err
}
func updateRun(tx *sql.Tx, r AgentRun) error {
	_, err := tx.Exec(`UPDATE agent_runs SET status=$1, updated_at=$2, started_at=$3, ended_at=$4, approval_request_id=NULLIF($5,''), retry=$6, accounting=$7, failure=$8 WHERE agent_run_id=$9`, r.Status, r.UpdatedAt, r.StartedAt, r.EndedAt, r.ApprovalRequestID, mustJSON(r.Retry), mustJSON(r.Accounting), failureJSON(r.Failure), r.AgentRunID)
	return err
}
func updateTool(tx *sql.Tx, t ToolExecution) error {
	_, err := tx.Exec(`UPDATE tool_executions SET status=$1, updated_at=$2, started_at=$3, ended_at=$4, approval_request_id=NULLIF($5,''), retry=$6, accounting=$7, failure=$8 WHERE tool_execution_id=$9`, t.Status, t.UpdatedAt, t.StartedAt, t.EndedAt, t.ApprovalRequestID, mustJSON(t.Retry), mustJSON(t.Accounting), failureJSON(t.Failure), t.ToolExecutionID)
	return err
}
func insertAudit(tx *sql.Tx, tenant TenantContext, id, action, targetType, targetID, outcome string) error {
	_, err := tx.Exec(`INSERT INTO agent_runtime_audit_refs (audit_id, tenant_id, trace_id, actor_id, target_type, target_id, action, outcome) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, id, tenant.TenantID, tenant.TraceID, tenant.ActorID, targetType, targetID, action, outcome)
	return err
}
func mustJSON(value any) []byte { result, _ := json.Marshal(value); return result }
func failureJSON(value *Failure) any {
	if value == nil {
		return nil
	}
	return mustJSON(value)
}
