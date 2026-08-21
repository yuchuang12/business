import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntimeFixture } from "../../packages/agent-runtime/src/index.mjs";
import { CommerceFixture, FIXTURE_CONTEXT, IDS } from "../../packages/commerce/src/golden-path-fixtures.mjs";

function runtimeProduct(product) {
  return {
    tenant_id: product.tenant_id,
    product_id: product.id,
    name: product.name,
    price_minor: product.price
  };
}

test("trusted context and canonical commerce data cross the runtime boundary", () => {
  const commerce = new CommerceFixture();
  const canonical = commerce.lookupProduct(FIXTURE_CONTEXT, { product_id: IDS.product });
  assert.equal(canonical.success, true);

  const runtime = new AgentRuntimeFixture({ products: [runtimeProduct(canonical.data.product)] });
  const result = runtime.lookupProduct({
    context: FIXTURE_CONTEXT,
    productId: canonical.data.product.id,
    idempotencyKey: "boundary-product-lookup-1"
  });

  assert.equal(result.response.success, true);
  assert.equal(result.response.trace_id, FIXTURE_CONTEXT.trace_id);
  assert.equal(result.response.data.product.product_id, canonical.data.product.id);
  assert.equal(runtime.executions.get(result.response.tool_execution_id).tenant_id, IDS.tenant);
});

test("approval-backed commerce action preserves canonical identifiers and trace", () => {
  const commerce = new CommerceFixture();
  const requested = commerce.requestAction(FIXTURE_CONTEXT, {
    action_type: "add_to_cart",
    site_id: IDS.site,
    product_id: IDS.product,
    idempotency_key: "boundary-cart-action-1"
  });
  assert.equal(requested.requires_approval, true);

  const executed = commerce.approveAction(FIXTURE_CONTEXT, { approval_id: requested.data.approval.id });
  assert.equal(executed.success, true);
  assert.equal(executed.data.action.site_id, IDS.site);
  assert.equal(executed.data.action.trace_id, FIXTURE_CONTEXT.trace_id);
  assert.equal(executed.data.cart.id, IDS.cart);
});

test("cross-tenant and caller-supplied security fields fail closed at both sides", () => {
  const foreignContext = {
    ...FIXTURE_CONTEXT,
    tenant_id: "ten_competitor",
    trace_id: "22222222222222222222222222222222"
  };
  const commerce = new CommerceFixture();
  assert.equal(
    commerce.lookupProduct(foreignContext, { product_id: IDS.product }).error.code,
    "not_visible"
  );

  const runtime = new AgentRuntimeFixture({
    products: [{ tenant_id: IDS.tenant, product_id: IDS.product, name: "Everyday Pet Food", price_minor: 2999 }]
  });
  const result = runtime.lookupProduct({
    context: FIXTURE_CONTEXT,
    productId: IDS.product,
    idempotencyKey: "boundary-hostile-input-1"
  });
  assert.equal(result.response.success, true);

  const rejected = runtime.executeTool({
    context: FIXTURE_CONTEXT,
    run: runtime.runs.get(result.run.agent_run_id),
    toolName: "product.lookup",
    input: { product_id: IDS.product, tenant_id: "ten_competitor" },
    idempotencyKey: "boundary-reserved-field-1"
  });
  assert.equal(rejected.error.code, "TOOL_INVALID_REQUEST");
});
