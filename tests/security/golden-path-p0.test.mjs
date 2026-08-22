import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntimeFixture } from "../../packages/agent-runtime/src/index.mjs";
import { CommerceFixture, ERROR_CODES, FIXTURE_CONTEXT, IDS } from "../../packages/commerce/src/golden-path-fixtures.mjs";
import { createGenerativeUiRenderer, validateGenerativeUiRequest } from "../../packages/ui/src/index.mjs";
import { readFile } from "node:fs/promises";

const foreignContext = {
  ...FIXTURE_CONTEXT,
  tenant_id: "ten_competitor",
  trace_id: "22222222222222222222222222222222"
};
const product = {
  tenant_id: IDS.tenant,
  product_id: IDS.product,
  name: "Everyday Pet Food",
  price_minor: 2999
};

test("cross-tenant reads and writes are denied without foreign data disclosure", () => {
  const commerce = new CommerceFixture();
  const read = commerce.lookupProduct(foreignContext, { product_id: IDS.product });
  const write = commerce.requestAction(foreignContext, {
    action_type: "add_to_cart", site_id: IDS.site, product_id: IDS.product,
    idempotency_key: "foreign-write-001"
  });
  const approval = commerce.approveAction(foreignContext, { approval_id: IDS.approval });

  assert.equal(read.error.code, ERROR_CODES.NOT_VISIBLE);
  assert.equal(write.error.code, ERROR_CODES.NOT_VISIBLE);
  assert.equal(approval.error.code, ERROR_CODES.NOT_VISIBLE);
  assert.doesNotMatch(JSON.stringify({ read, write, approval }), /ten_pet_store|Everyday Pet Food/);
});

test("unauthorized tools and hostile payloads fail closed with correlated audit responses", () => {
  const runtime = new AgentRuntimeFixture({ products: [product] });
  const noRead = {
    ...FIXTURE_CONTEXT,
    scopes: ["agent:run"]
  };
  const denied = runtime.lookupProduct({
    context: noRead, productId: IDS.product, idempotencyKey: "unauthorized-001"
  }).response;
  const started = runtime.startRun(FIXTURE_CONTEXT);
  const hostile = runtime.executeTool({
    context: FIXTURE_CONTEXT, run: started.run, toolName: "product.lookup",
    input: { product_id: IDS.product, tenant_id: "ten_competitor", secret: "do-not-echo" },
    idempotencyKey: "hostile-input-001"
  });

  for (const response of [denied, hostile]) {
    assert.equal(response.success, false);
    assert.equal(response.trace_id, FIXTURE_CONTEXT.trace_id);
    assert.match(response.audit_id, /^audit_/);
    assert.equal(response.idempotency_key.length >= 16, true);
  }
  assert.equal(denied.error.code, "TOOL_FORBIDDEN");
  assert.equal(hostile.error.code, "TOOL_INVALID_REQUEST");
  assert.doesNotMatch(JSON.stringify(hostile), /ten_competitor|do-not-echo/);
});

test("approval is required, bound to the original request, and cannot be replayed with changed input", () => {
  const runtime = new AgentRuntimeFixture({
    products: [product],
    approve: () => true
  });
  const started = runtime.startRun(FIXTURE_CONTEXT);
  const pending = runtime.executeTool({
    context: FIXTURE_CONTEXT, run: started.run, toolName: "product.lookup",
    input: { product_id: IDS.product }, idempotencyKey: "approval-bound-001", highRisk: true
  });
  assert.equal(pending.error.code, "TOOL_APPROVAL_REQUIRED");
  assert.equal(runtime.executions.size, 1);

  const changed = runtime.executeTool({
    context: FIXTURE_CONTEXT, run: started.run, toolName: "product.lookup",
    input: { product_id: "product_other" }, idempotencyKey: "approval-bound-001",
    highRisk: true, approvalId: started.run.approval_request_id
  });
  assert.equal(changed.error.code, "TOOL_APPROVAL_EXPIRED");
  assert.equal(runtime.executions.size, 1);

  const resumed = runtime.executeTool({
    context: FIXTURE_CONTEXT, run: started.run, toolName: "product.lookup",
    input: { product_id: IDS.product }, idempotencyKey: "approval-bound-001",
    highRisk: true, approvalId: started.run.approval_request_id
  });
  assert.equal(resumed.success, true);
});

class Element {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.listeners = {};
    this.textContent = "";
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute() {}
  addEventListener(name, handler) { this.listeners[name] = handler; }
  click() { this.listeners.click?.(); }
}

function findButtons(node) {
  return [
    ...(node.tagName === "BUTTON" ? [node] : []),
    ...node.children.flatMap(findButtons)
  ];
}

test("GenerativeUI validates hostile requests and emits approval intent without executing tools", async () => {
  const request = JSON.parse(await readFile(new URL("../../contracts/generative-ui/v1/examples/golden-path.json", import.meta.url)));
  const hostile = structuredClone(request);
  hostile.components[0].type = "arbitrary_html";
  assert.equal(validateGenerativeUiRequest(hostile).valid, false);

  const actions = [];
  const renderer = createGenerativeUiRenderer({
    document: { createElement: (tagName) => new Element(tagName) },
    resolver: { resolve: async (kind, id, context) => ({ kind, id, tenant_id: context.tenant_id }) },
    onAction: (action) => actions.push(action)
  });
  const mount = new Element("main");
  await renderer.render(request, mount);
  const buttons = findButtons(mount);
  assert.ok(buttons.length > 0);
  buttons.find((button) => button.textContent === "Publish").click();
  assert.equal(actions.length, 1);
  assert.equal(actions[0].approval_request_id, "approval_001");
  assert.equal(actions[0].tenant_id, request.tenant_context_ref.tenant_id);
});
