import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntimeFixture } from "../../packages/agent-runtime/src/index.mjs";

const context = {
  schema_version: "1.0", tenant_id: "ten_pet_store", actor_id: "session_customer",
  actor_type: "customer_session", roles: ["customer"], scopes: ["product:read", "agent:run"],
  trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
  request_origin: { kind: "customer_site", request_id: "req_customer_1" }
};
const product = { tenant_id: "ten_pet_store", product_id: "product_food", name: "Gentle Bites", price_minor: 1299 };

test("customer entry creates correlated run and tenant-scoped typed lookup", () => {
  const runtime = new AgentRuntimeFixture({ products: [product] });
  const result = runtime.lookupProduct({ context, productId: product.product_id, idempotencyKey: "lookup-product-food-1" });
  assert.equal(result.response.success, true);
  assert.equal(result.response.data.product.product_id, "product_food");
  assert.equal(result.response.trace_id, result.run.trace_id);
  assert.equal(runtime.executions.get(result.response.tool_execution_id).agent_run_id, result.run.agent_run_id);
});

test("foreign products are redacted as not found and hostile tenant input fails closed", () => {
  const runtime = new AgentRuntimeFixture({ products: [{ ...product, tenant_id: "ten_other" }] });
  const hidden = runtime.lookupProduct({ context, productId: product.product_id, idempotencyKey: "lookup-foreign-product-1" });
  assert.equal(hidden.response.error.code, "TOOL_NOT_FOUND");
  const started = runtime.startRun(context);
  const hostile = runtime.executeTool({
    context, run: started.run, toolName: "product.lookup",
    input: { product_id: product.product_id, tenant_id: "ten_other" },
    idempotencyKey: "lookup-hostile-input-1"
  });
  assert.equal(hostile.error.code, "TOOL_INVALID_REQUEST");
});

test("approval-gated execution pauses and resumes without changing run identity", () => {
  const runtime = new AgentRuntimeFixture({ products: [product], approve: ({ approvalId }) => approvalId === "approval_1" });
  const started = runtime.startRun(context);
  const paused = runtime.executeTool({
    context, run: started.run, toolName: "product.lookup", input: { product_id: product.product_id },
    idempotencyKey: "approval-product-lookup-1", highRisk: true
  });
  assert.equal(paused.error.code, "TOOL_APPROVAL_REQUIRED");
  assert.equal(started.run.status, "waiting_approval");
  const resumed = runtime.executeTool({
    context, run: started.run, toolName: "product.lookup", input: { product_id: product.product_id },
    idempotencyKey: "approval-product-lookup-1", highRisk: true, approvalId: "approval_1"
  });
  assert.equal(resumed.success, true);
  assert.equal(started.run.agent_run_id, runtime.executions.get(resumed.tool_execution_id).agent_run_id);
});

test("retryable provider failure replays idempotently and conflicts on changed input", () => {
  let calls = 0;
  const runtime = new AgentRuntimeFixture({
    products: [product],
    productProvider: () => { calls += 1; if (calls === 1) throw new Error("provider down"); return product; }
  });
  const first = runtime.lookupProduct({ context, productId: product.product_id, idempotencyKey: "retry-product-lookup-1" });
  assert.equal(first.response.error.code, "TOOL_PROVIDER_FAILED");
  const retry = runtime.resumeRetry({ context, runId: first.run.agent_run_id, productId: product.product_id, idempotencyKey: "retry-product-lookup-1" });
  assert.equal(retry.response.success, true);
  assert.equal(calls, 2);
  const conflict = runtime.executeTool({
    context, run: runtime.runs.get(first.run.agent_run_id), toolName: "product.lookup",
    input: { product_id: "product_other" }, idempotencyKey: "retry-product-lookup-1"
  });
  assert.equal(conflict.error.code, "TOOL_CONFLICT");
});
