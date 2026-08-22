package agentruntime

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestPostgresRuntimeStoreRequiresDatabase(t *testing.T) {
	if _, err := NewPostgresRuntimeStore(nil); err == nil {
		t.Fatal("expected nil database to fail")
	}
}

func TestPostgresRuntimeStoreClaimsAndReconcilesEffects(t *testing.T) {
	db := NewPostgresTestDatabase(t)
	store, err := NewPostgresRuntimeStore(db)
	if err != nil {
		t.Fatal(err)
	}
	ctx := serviceContext("tenant_a", "actor_a")
	if _, err := db.ExecContext(context.Background(), `
		INSERT INTO agent_runs (
			agent_run_id, contract_version, tenant_id, actor_id, trace_id, agent_type, status,
			created_at, updated_at, attempt, retry, accounting, audit_id
		) VALUES ($1, '1.0', $2, $3, $4, 'merchant', 'running',
			CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, '{}', '{"currency":"USD"}', 'audit_101')`,
		"run_100", ctx.TenantID, ctx.ActorID, ctx.TraceID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(context.Background(), `
		INSERT INTO tool_executions (
			tool_execution_id, agent_run_id, contract_version, tenant_id, actor_id, trace_id,
			tool_name, tool_version, idempotency_key, status, created_at, updated_at,
			attempt, retry, accounting, audit_id
		) VALUES ($1, $2, '1.0', $3, $4, $5, 'site.publish', '1.0',
			'provider-request-001', 'running', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
			1, '{}', '{"currency":"USD"}', 'audit_102')`,
		"exec_100", "run_100", ctx.TenantID, ctx.ActorID, ctx.TraceID); err != nil {
		t.Fatal(err)
	}
	effect := providerEffect(ctx)
	const workers = 12
	var wg sync.WaitGroup
	errs := make(chan error, workers)
	newClaims := make(chan bool, workers)
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			claim, err := store.ClaimProviderEffect(ctx, effect)
			if err == nil {
				newClaims <- !claim.Existing
			}
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	close(newClaims)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	created := 0
	for fresh := range newClaims {
		if fresh {
			created++
		}
	}
	if created != 1 {
		t.Fatalf("new provider effect claims = %d, want 1", created)
	}
	conflictingEffect := effect
	conflictingEffect.CorrelationID = "correlation_101"
	if _, err := store.ClaimProviderEffect(ctx, conflictingEffect); ErrorCode(err) != "RUNTIME_CONFLICT" {
		t.Fatalf("changed provider binding error = %v", err)
	}
	now := time.Now().UTC().Round(time.Microsecond)
	if err := store.RecordProviderEffect(ctx, effect, ProviderEffectReconciliation{
		State: ProviderEffectUnknown, ObservedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	result, err := store.ReconcileProviderEffect(ctx, effect)
	if err != nil {
		t.Fatal(err)
	}
	if result.State != ProviderEffectUnknown || result.CanAutoRetry() {
		t.Fatalf("reconciliation = %+v, want fail-closed unknown", result)
	}
	if _, conflict, err := store.ClaimIdempotency("tenant_a:agent-run:request-001", strings.Repeat("a", 64), "run_100"); err != nil || conflict {
		t.Fatalf("first idempotency claim = conflict %t, err %v", conflict, err)
	}
	if existing, conflict, err := store.ClaimIdempotency("tenant_a:agent-run:request-001", strings.Repeat("b", 64), "run_101"); err != nil || !conflict || existing != "run_100" {
		t.Fatalf("conflicting idempotency claim = (%q, %t, %v)", existing, conflict, err)
	}
	if _, err := db.ExecContext(context.Background(), `
		UPDATE agent_runs SET recovery_claim_until = CURRENT_TIMESTAMP - INTERVAL '1 second'
		WHERE agent_run_id = $1`, effect.AgentRunID); err != nil {
		t.Fatal(err)
	}
	claimed, err := store.ClaimRecoverableWork(ctx.TenantID, 1)
	if err != nil || fmt.Sprint(claimed) != "[run_100]" {
		t.Fatalf("recoverable work = %v, %v", claimed, err)
	}
	events, err := store.QueryOperationalAudit(ctx, OperationalAuditQuery{CorrelationID: effect.CorrelationID})
	if err != nil || len(events) != 1 {
		t.Fatalf("correlation audit = %+v, %v", events, err)
	}
	if events[0].TenantID != ctx.TenantID || events[0].TraceID != ctx.TraceID || events[0].CorrelationID != effect.CorrelationID || events[0].Outcome != string(ProviderEffectUnknown) {
		t.Fatalf("correlation audit event = %+v", events[0])
	}
}
