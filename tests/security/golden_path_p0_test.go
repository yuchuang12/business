package security_test

import (
	"testing"

	agentruntime "github.com/yuchuang12/business/packages/agent-runtime"
)

var securityContext = agentruntime.TenantContext{
	SchemaVersion: agentruntime.ContractVersion, TenantID: "ten_pet_store", ActorID: "session_customer",
	ActorType: "customer_session", Roles: []string{"customer"}, Scopes: []string{"product:read", "agent:run"},
	TraceID:       "4bf92f3577b34da6a3ce929d0e0e4736",
	RequestOrigin: agentruntime.RequestOrigin{Kind: "customer_site", RequestID: "req_customer_1"},
}

var securityProduct = agentruntime.Product{
	TenantID: "ten_pet_store", ProductID: "product_pet_food", Name: "Everyday Pet Food", PriceMinor: 2999,
}

func TestRuntimeDenialsAreCorrelatedAndRedacted(t *testing.T) {
	runtime := agentruntime.NewAgentRuntimeFixture([]agentruntime.Product{securityProduct}, nil, nil)
	noRead := securityContext
	noRead.Scopes = []string{"agent:run"}
	denied, err := runtime.LookupProduct(noRead, securityProduct.ProductID, "unauthorized-001")
	if err != nil || denied.Response.Error == nil || denied.Response.Error.Code != "TOOL_FORBIDDEN" {
		t.Fatalf("unauthorized lookup = %+v, %v", denied.Response, err)
	}
	started, err := runtime.StartRun(securityContext)
	if err != nil {
		t.Fatal(err)
	}
	hostile, err := runtime.ExecuteTool(agentruntime.ExecuteToolRequest{
		Context: securityContext, RunID: started.Run.AgentRunID, ToolName: "product.lookup",
		Input:          map[string]any{"product_id": securityProduct.ProductID, "tenant_id": "ten_competitor", "secret": "do-not-echo"},
		IdempotencyKey: "hostile-input-001",
	})
	if err != nil || hostile.Error == nil || hostile.Error.Code != "TOOL_INVALID_REQUEST" {
		t.Fatalf("hostile request = %+v, %v", hostile, err)
	}
	for _, response := range []agentruntime.ToolResponse{denied.Response, hostile} {
		if response.TraceID != securityContext.TraceID || response.AuditID == "" || len(response.IdempotencyKey) < 16 {
			t.Fatalf("uncorrelated denial: %+v", response)
		}
	}
}

func TestApprovalIsBoundToOriginalRequest(t *testing.T) {
	runtime := agentruntime.NewAgentRuntimeFixture([]agentruntime.Product{securityProduct}, func(agentruntime.FixtureApprovalRequest) bool {
		return true
	}, nil)
	started, err := runtime.StartRun(securityContext)
	if err != nil {
		t.Fatal(err)
	}
	pending, err := runtime.ExecuteTool(agentruntime.ExecuteToolRequest{
		Context: securityContext, RunID: started.Run.AgentRunID, ToolName: "product.lookup",
		Input: map[string]any{"product_id": securityProduct.ProductID}, IdempotencyKey: "approval-bound-001", HighRisk: true,
	})
	if err != nil || pending.Error == nil || pending.Error.Code != "TOOL_APPROVAL_REQUIRED" {
		t.Fatalf("pending approval = %+v, %v", pending, err)
	}
	run, err := runtime.Service.Run(securityContext, started.Run.AgentRunID)
	if err != nil {
		t.Fatal(err)
	}
	changed, err := runtime.ExecuteTool(agentruntime.ExecuteToolRequest{
		Context: securityContext, RunID: started.Run.AgentRunID, ToolName: "product.lookup",
		Input: map[string]any{"product_id": "product_other"}, IdempotencyKey: "approval-bound-001",
		HighRisk: true, ApprovalID: run.ApprovalRequestID,
	})
	if err != nil || changed.Error == nil || changed.Error.Code != "TOOL_APPROVAL_EXPIRED" {
		t.Fatalf("changed approval request = %+v, %v", changed, err)
	}
	resumed, err := runtime.ExecuteTool(agentruntime.ExecuteToolRequest{
		Context: securityContext, RunID: started.Run.AgentRunID, ToolName: "product.lookup",
		Input: map[string]any{"product_id": securityProduct.ProductID}, IdempotencyKey: "approval-bound-001",
		HighRisk: true, ApprovalID: run.ApprovalRequestID,
	})
	if err != nil || !resumed.Success {
		t.Fatalf("approved request = %+v, %v", resumed, err)
	}
}
