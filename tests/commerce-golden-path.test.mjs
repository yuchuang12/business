import assert from "node:assert/strict";
import test from "node:test";
import { CommerceFixture, ERROR_CODES, FIXTURE_CONTEXT, IDS } from "../packages/commerce/src/golden-path-fixtures.mjs";

const otherTenant = { ...FIXTURE_CONTEXT, tenant_id: "ten_competitor", trace_id: "22222222222222222222222222222222" };

test("typed product lookup returns canonical tenant-scoped product and site", () => {
  const result = new CommerceFixture().lookupProduct(FIXTURE_CONTEXT, { product_id: IDS.product });
  assert.equal(result.success, true);
  assert.deepEqual(result.data.product, {
    id: IDS.product, tenant_id: IDS.tenant, site_id: IDS.site, sku: "PET-FOOD-001",
    name: "Everyday Pet Food", price: 2999, currency: "CNY", status: "active"
  });
  assert.equal(result.data.site.id, IDS.site);
});

test("cross-tenant product and approval references are not visible", () => {
  const fixture = new CommerceFixture();
  assert.equal(fixture.lookupProduct(otherTenant, { product_id: IDS.product }).error.code, ERROR_CODES.NOT_VISIBLE);
  assert.equal(fixture.approveAction(otherTenant, { approval_id: IDS.approval }).error.code, ERROR_CODES.NOT_VISIBLE);
});

test("cart action pauses for approval and executes with canonical references", () => {
  const fixture = new CommerceFixture();
  const requested = fixture.requestAction(FIXTURE_CONTEXT, {
    action_type: "add_to_cart", site_id: IDS.site, product_id: IDS.product, idempotency_key: "cart-request-001"
  });
  assert.equal(requested.success, false);
  assert.equal(requested.error.code, ERROR_CODES.APPROVAL_REQUIRED);
  assert.equal(requested.requires_approval, true);
  assert.equal(requested.data.approval.id, IDS.approval);
  const executed = fixture.approveAction(FIXTURE_CONTEXT, { approval_id: IDS.approval });
  assert.equal(executed.data.action.id, IDS.action);
  assert.equal(executed.data.cart.id, IDS.cart);
  assert.equal(executed.data.action.trace_id, FIXTURE_CONTEXT.trace_id);
});

test("lead action is approval-backed and repeated idempotency does not create another approval", () => {
  const fixture = new CommerceFixture();
  const input = { action_type: "create_lead", site_id: IDS.site, product_id: IDS.product, idempotency_key: "lead-request-001" };
  const first = fixture.requestAction(FIXTURE_CONTEXT, input);
  const replay = fixture.requestAction(FIXTURE_CONTEXT, input);
  assert.equal(first.data.approval.id, IDS.approval);
  assert.equal(replay.data.approval.id, IDS.approval);
  assert.equal(fixture.approveAction(FIXTURE_CONTEXT, { approval_id: IDS.approval }).data.lead.id, IDS.lead);
});

test("reserved identity fields and invalid contexts fail closed", () => {
  const fixture = new CommerceFixture();
  assert.equal(fixture.lookupProduct(FIXTURE_CONTEXT, { product_id: IDS.product, tenant_id: "ten_competitor" }).error.code, ERROR_CODES.FORBIDDEN);
  assert.equal(fixture.lookupProduct({ ...FIXTURE_CONTEXT, trace_id: "bad" }, { product_id: IDS.product }).error.code, ERROR_CODES.INVALID_CONTEXT);
});
