package agentruntime

import (
	"context"
	"testing"
	"time"
)

func TestProductionServiceRequiresPostgresStore(t *testing.T) {
	if _, err := NewProductionAgentRuntimeService(nil, nil, nil); err == nil {
		t.Fatal("production service accepted nil postgres store")
	}
}

func TestProductionServicePersistsRestartRecoveryAndFailsClosed(t *testing.T) {
	db := NewPostgresTestDatabase(t)
	store, err := NewPostgresRuntimeStore(db)
	if err != nil {
		t.Fatal(err)
	}
	first, err := NewProductionAgentRuntimeService(store, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	tenant := serviceContext("tenant_a", "actor_a")
	run, duplicate, err := first.CreateRun(tenant, CreateRunOptions{IdempotencyKey: "production-run-request-01"})
	if err != nil || duplicate {
		t.Fatalf("create run = (%+v, %t, %v)", run, duplicate, err)
	}
	if _, err := first.TransitionRun(tenant, run.AgentRunID, "running", ""); err != nil {
		t.Fatal(err)
	}
	tool, duplicate, err := first.CreateToolExecution(tenant, CreateToolOptions{
		AgentRunID: run.AgentRunID, ToolName: "site.publish", IdempotencyKey: "production-tool-request-01",
	})
	if err != nil || duplicate {
		t.Fatalf("create tool = (%+v, %t, %v)", tool, duplicate, err)
	}
	if _, err := first.TransitionTool(tenant, tool.ToolExecutionID, "running", ""); err != nil {
		t.Fatal(err)
	}
	effect := providerEffect(tenant)
	effect.AgentRunID, effect.ToolExecutionID, effect.IdempotencyKey = run.AgentRunID, tool.ToolExecutionID, tool.IdempotencyKey
	effect.ReconcileBy = time.Now().UTC().Add(time.Minute)
	if _, err := store.ClaimProviderEffect(tenant, effect); err != nil {
		t.Fatal(err)
	}

	// This is intentionally a distinct service instance over the same database.
	restarted, err := NewProductionAgentRuntimeService(store, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	recovered, err := restarted.Recover(tenant)
	if err != nil || len(recovered) != 1 || recovered[0] != run.AgentRunID {
		t.Fatalf("recover = %v, %v", recovered, err)
	}
	reloadedRun, err := restarted.Run(tenant, run.AgentRunID)
	if err != nil || reloadedRun.Status != "failed" || reloadedRun.Failure == nil || reloadedRun.Failure.Code != "RUNTIME_UNKNOWN_IN_FLIGHT_EFFECT" {
		t.Fatalf("reloaded run = %+v, %v", reloadedRun, err)
	}
	reloadedTool, err := restarted.Tool(tenant, tool.ToolExecutionID)
	if err != nil || reloadedTool.Status != "failed" {
		t.Fatalf("reloaded tool = %+v, %v", reloadedTool, err)
	}
	reconciliation, err := store.ReconcileProviderEffect(tenant, effect)
	if err != nil || reconciliation.State != ProviderEffectUnknown || reconciliation.CanAutoRetry() {
		t.Fatalf("reconciliation = %+v, %v", reconciliation, err)
	}
	var audits int
	if err := db.QueryRowContext(context.Background(), `SELECT count(*) FROM agent_runtime_audit_refs WHERE tenant_id = $1`, tenant.TenantID).Scan(&audits); err != nil || audits < 5 {
		t.Fatalf("durable audits = %d, %v", audits, err)
	}
}
