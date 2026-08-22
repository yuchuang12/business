import assert from "node:assert/strict";
import test from "node:test";
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
