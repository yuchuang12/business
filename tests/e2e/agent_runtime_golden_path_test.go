package e2e_test

import (
	"errors"
	"testing"

	agentruntime "github.com/yuchuang12/business/packages/agent-runtime"
)

var customerContext = agentruntime.TenantContext{
	SchemaVersion: agentruntime.ContractVersion, TenantID: "ten_pet_store", ActorID: "session_customer",
	ActorType: "customer_session", Roles: []string{"customer"}, Scopes: []string{"product:read", "agent:run"},
	TraceID:       "4bf92f3577b34da6a3ce929d0e0e4736",
	RequestOrigin: agentruntime.RequestOrigin{Kind: "customer_site", RequestID: "req_customer_1"},
}

var fixtureProduct = agentruntime.Product{
	TenantID: "ten_pet_store", ProductID: "product_food", Name: "Gentle Bites", PriceMinor: 1299,
}

func TestCustomerEntryCreatesCorrelatedTenantScopedLookup(t *testing.T) {
	runtime := agentruntime.NewAgentRuntimeFixture([]agentruntime.Product{fixtureProduct}, nil, nil)
	result, err := runtime.LookupProduct(customerContext, fixtureProduct.ProductID, "lookup-product-food-1")
	if err != nil || !result.Response.Success {
		t.Fatalf("lookup = %+v, %v", result, err)
	}
	product := result.Response.Data.(map[string]any)["product"].(agentruntime.Product)
	if product.ProductID != fixtureProduct.ProductID || result.Response.TraceID != result.Run.TraceID {
		t.Fatalf("unexpected response: %+v", result.Response)
	}
	execution, err := runtime.Execution(customerContext, result.Response.ToolExecutionID)
	if err != nil || execution.AgentRunID != result.Run.AgentRunID {
		t.Fatalf("execution = %+v, %v", execution, err)
	}
}

func TestForeignAndReservedTenantInputFailClosed(t *testing.T) {
	runtime := agentruntime.NewAgentRuntimeFixture([]agentruntime.Product{{TenantID: "ten_other", ProductID: fixtureProduct.ProductID}}, nil, nil)
	hidden, err := runtime.LookupProduct(customerContext, fixtureProduct.ProductID, "lookup-foreign-product-1")
	if err != nil || hidden.Response.Error.Code != "TOOL_NOT_FOUND" {
		t.Fatalf("foreign product = %+v, %v", hidden.Response, err)
	}
	started, err := runtime.StartRun(customerContext)
	if err != nil {
		t.Fatal(err)
	}
	hostile, err := runtime.ExecuteTool(agentruntime.ExecuteToolRequest{
		Context: customerContext, RunID: started.Run.AgentRunID, ToolName: "product.lookup",
		Input:          map[string]any{"product_id": fixtureProduct.ProductID, "tenant_id": "ten_other"},
		IdempotencyKey: "lookup-hostile-input-1",
	})
	if err != nil || hostile.Error.Code != "TOOL_INVALID_REQUEST" {
		t.Fatalf("hostile input = %+v, %v", hostile, err)
	}
}

func TestApprovalRetryIdempotencyAndConflict(t *testing.T) {
	approvalRuntime := agentruntime.NewAgentRuntimeFixture([]agentruntime.Product{fixtureProduct}, func(request agentruntime.FixtureApprovalRequest) bool {
		return request.ApprovalID == "approval_1"
	}, nil)
	started, err := approvalRuntime.StartRun(customerContext)
	if err != nil {
		t.Fatal(err)
	}
	paused, err := approvalRuntime.ExecuteTool(agentruntime.ExecuteToolRequest{
		Context: customerContext, RunID: started.Run.AgentRunID, ToolName: "product.lookup",
		Input: map[string]any{"product_id": fixtureProduct.ProductID}, IdempotencyKey: "approval-product-lookup-1", HighRisk: true,
	})
	if err != nil || paused.Error.Code != "TOOL_APPROVAL_REQUIRED" {
		t.Fatalf("pause = %+v, %v", paused, err)
	}
	run, err := approvalRuntime.Service.Run(customerContext, started.Run.AgentRunID)
	if err != nil || run.Status != "waiting_approval" {
		t.Fatalf("paused run = %+v, %v", run, err)
	}
	resumed, err := approvalRuntime.ExecuteTool(agentruntime.ExecuteToolRequest{
		Context: customerContext, RunID: started.Run.AgentRunID, ToolName: "product.lookup",
		Input: map[string]any{"product_id": fixtureProduct.ProductID}, IdempotencyKey: "approval-product-lookup-1", HighRisk: true, ApprovalID: "approval_1",
	})
	if err != nil || !resumed.Success {
		t.Fatalf("resume = %+v, %v", resumed, err)
	}
	execution, err := approvalRuntime.Execution(customerContext, resumed.ToolExecutionID)
	if err != nil || execution.AgentRunID != started.Run.AgentRunID {
		t.Fatalf("resumed execution = %+v, %v", execution, err)
	}

	calls := 0
	retryRuntime := agentruntime.NewAgentRuntimeFixture([]agentruntime.Product{fixtureProduct}, nil, func(product agentruntime.Product) (agentruntime.Product, error) {
		calls++
		if calls == 1 {
			return agentruntime.Product{}, errors.New("provider down")
		}
		return product, nil
	})
	first, err := retryRuntime.LookupProduct(customerContext, fixtureProduct.ProductID, "retry-product-lookup-1")
	if err != nil || first.Response.Error.Code != "TOOL_PROVIDER_FAILED" {
		t.Fatalf("first provider call = %+v, %v", first.Response, err)
	}
	retry, err := retryRuntime.ResumeRetry(customerContext, first.Run.AgentRunID, fixtureProduct.ProductID, "retry-product-lookup-1")
	if err != nil || !retry.Response.Success || calls != 2 {
		t.Fatalf("retry = %+v, calls=%d, err=%v", retry, calls, err)
	}
	conflict, err := retryRuntime.ExecuteTool(agentruntime.ExecuteToolRequest{
		Context: customerContext, RunID: first.Run.AgentRunID, ToolName: "product.lookup",
		Input: map[string]any{"product_id": "product_other"}, IdempotencyKey: "retry-product-lookup-1",
	})
	if err != nil || conflict.Error.Code != "TOOL_CONFLICT" {
		t.Fatalf("conflict = %+v, %v", conflict, err)
	}
}
