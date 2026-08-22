package e2e_test

import (
	"testing"

	agentruntime "github.com/yuchuang12/business/packages/agent-runtime"
)

func TestTrustedContextAndCanonicalProductCrossRuntimeBoundary(t *testing.T) {
	canonical := agentruntime.Product{
		TenantID: customerContext.TenantID, ProductID: "product_pet_food", Name: "Everyday Pet Food", PriceMinor: 2999,
	}
	runtime := agentruntime.NewAgentRuntimeFixture([]agentruntime.Product{canonical}, nil, nil)
	result, err := runtime.LookupProduct(customerContext, canonical.ProductID, "boundary-product-lookup-1")
	if err != nil || !result.Response.Success || result.Response.TraceID != customerContext.TraceID {
		t.Fatalf("runtime boundary = %+v, %v", result, err)
	}
	product := result.Response.Data.(map[string]any)["product"].(agentruntime.Product)
	if product.ProductID != canonical.ProductID {
		t.Fatalf("canonical product changed: %+v", product)
	}
	execution, err := runtime.Execution(customerContext, result.Response.ToolExecutionID)
	if err != nil || execution.TenantID != customerContext.TenantID {
		t.Fatalf("execution tenant = %+v, %v", execution, err)
	}
}

func TestRuntimeBoundaryRejectsCrossTenantAndCallerSecurityFields(t *testing.T) {
	runtime := agentruntime.NewAgentRuntimeFixture([]agentruntime.Product{{
		TenantID: customerContext.TenantID, ProductID: "product_pet_food", Name: "Everyday Pet Food", PriceMinor: 2999,
	}}, nil, nil)
	result, err := runtime.LookupProduct(customerContext, "product_pet_food", "boundary-hostile-input-1")
	if err != nil || !result.Response.Success {
		t.Fatalf("valid lookup = %+v, %v", result, err)
	}
	rejected, err := runtime.ExecuteTool(agentruntime.ExecuteToolRequest{
		Context: customerContext, RunID: result.Run.AgentRunID, ToolName: "product.lookup",
		Input:          map[string]any{"product_id": "product_pet_food", "tenant_id": "ten_competitor"},
		IdempotencyKey: "boundary-reserved-field-1",
	})
	if err != nil || rejected.Error.Code != "TOOL_INVALID_REQUEST" {
		t.Fatalf("reserved field result = %+v, %v", rejected, err)
	}
}
