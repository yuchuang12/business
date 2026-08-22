import assert from "node:assert/strict";
import test from "node:test";
import { CommerceError, CommerceService, InMemoryCommerceStore } from "../src/index.mjs";

const context = (tenant_id, actor_id = "user_merchant") => ({
  schema_version: "1.0", tenant_id, actor_id, actor_type: "user", roles: ["tenant_owner"],
  scopes: ["product:read", "product:write", "cart:write", "order:write", "lead:write"],
  trace_id: tenant_id === "ten_other" ? "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" : "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  request_origin: { kind: "merchant_console", request_id: "req_merchant_001" }
});
const expectCode = (code, fn) => assert.throws(fn, (error) => error instanceof CommerceError && error.code === code);

test("product lookup returns canonical IDs and is tenant scoped", () => {
  const service = new CommerceService({ store: new InMemoryCommerceStore() });
  const one = context("ten_one");
  const two = context("ten_two");
  service.createProduct(one, { id: "caller_product", name: "Tea", price_minor: 1200, canonical_id: "spoofed" });
  service.createProduct(two, { name: "Coffee", price_minor: 800 });
  assert.match(service.lookupProducts(one).items[0].product_id, /^product_/);
  assert.notEqual(service.lookupProducts(one).items[0].product_id, "caller_product");
  assert.equal(service.lookupProducts(one, { query: "Coffee" }).total, 0);
  expectCode("COMMERCE_NOT_FOUND", () => service.get(one, "products", "missing_product"));
});

test("repositories reject missing context and caller tenant injection", () => {
  const service = new CommerceService({ store: new InMemoryCommerceStore() });
  expectCode("COMMERCE_INVALID_REQUEST", () => service.createProduct(undefined, { name: "Tea", price_minor: 1 }));
  expectCode("COMMERCE_INVALID_REQUEST", () => service.createProduct(context("ten_one"), { name: "Tea", price_minor: 1, tenant_id: "ten_two" }));
});

test("cart summary resolves products under the same tenant", () => {
  const service = new CommerceService({ store: new InMemoryCommerceStore() });
  const one = context("ten_one");
  const product = service.createProduct(one, { name: "Tea", price_minor: 1200 });
  const cart = service.createCart(one);
  service.addToCart(one, { cart_id: cart.id, product_id: product.id, quantity: 2, idempotency_key: "cart-key-00000001" });
  assert.equal(service.getCartSummary(one, cart.id).total_minor, 2400);
  expectCode("COMMERCE_NOT_FOUND", () => service.getCartSummary(context("ten_two"), cart.id));
});

test("lead capture is idempotent and rejects conflicting reuse", () => {
  const service = new CommerceService({ store: new InMemoryCommerceStore() });
  const one = context("ten_one");
  const input = { email: "buyer@example.com", summary: "Interested", idempotency_key: "lead-key-00000001" };
  const first = service.captureLead(one, input);
  assert.equal(service.captureLead(one, input).id, first.id);
  expectCode("COMMERCE_CONFLICT", () => service.captureLead(one, { ...input, summary: "Changed" }));
  expectCode("COMMERCE_INVALID_REQUEST", () => service.captureLead(one, { email: "x@example.com", idempotency_key: "short" }));
});

test("order creation requires approval and replays idempotently", () => {
  const service = new CommerceService({ store: new InMemoryCommerceStore(), approvalValidator: (approval) => approval.status === "approved" });
  const one = context("ten_one");
  const cart = service.createCart(one);
  expectCode("COMMERCE_APPROVAL_REQUIRED", () => service.createOrder(one, { cart_id: cart.id, idempotency_key: "order-key-00000001" }));
  const input = { cart_id: cart.id, idempotency_key: "order-key-00000001", approval_reference: { id: "approval_1", status: "approved" } };
  const order = service.createOrder(one, input);
  assert.equal(service.createOrder(one, input).id, order.id);
  expectCode("COMMERCE_CONFLICT", () => service.createOrder(one, { ...input, approval_reference: { id: "approval_2", status: "approved" } }));
});

test("cart items can be updated or removed idempotently", () => {
  const service = new CommerceService({ store: new InMemoryCommerceStore() });
  const one = context("ten_one");
  const product = service.createProduct(one, { name: "Tea", price_minor: 1200 });
  const cart = service.createCart(one);
  service.addToCart(one, { cart_id: cart.id, product_id: product.id, quantity: 1, idempotency_key: "cart-key-00000002" });
  const updated = service.updateCartItem(one, {
    cart_id: cart.id, product_id: product.id, quantity: 3, idempotency_key: "cart-key-00000003"
  });
  assert.equal(updated.items[0].quantity, 3);
  assert.equal(service.removeFromCart(one, {
    cart_id: cart.id, product_id: product.id, idempotency_key: "cart-key-00000004"
  }).items.length, 0);
});

test("recommendation candidates and order intent retain tenant and audit boundaries", () => {
  const store = new InMemoryCommerceStore();
  const service = new CommerceService({ store, approvalValidator: (approval) => approval.status === "approved" });
  const one = context("ten_one");
  const product = service.createProduct(one, { name: "Tea", price_minor: 1200 });
  service.createProduct(context("ten_two"), { name: "Coffee", price_minor: 800 });
  assert.deepEqual(service.getRecommendationCandidates(one, { query: "tea" }).items.map((item) => item.product_id), [product.id]);
  const cart = service.createCart(one);
  assert.throws(() => service.createOrderIntent(one, {
    cart_id: cart.id, idempotency_key: "intent-key-00000001"
  }), (error) => error.code === "COMMERCE_APPROVAL_REQUIRED");
  assert.ok(store.audit.some((entry) => entry.action === "product.recommendation_candidates" && entry.trace_id === one.trace_id));
});

test("tenant context rejects unknown schema fields, roles, scopes, and origins", () => {
  const service = new CommerceService({ store: new InMemoryCommerceStore() });
  expectCode("COMMERCE_INVALID_REQUEST", () => service.lookupProducts({ ...context("ten_one"), unknown: true }));
  expectCode("COMMERCE_INVALID_REQUEST", () => service.lookupProducts({ ...context("ten_one"), roles: ["superuser"] }));
  expectCode("COMMERCE_INVALID_REQUEST", () => service.lookupProducts({ ...context("ten_one"), request_origin: { kind: "webhook", request_id: "req_merchant_001" } }));
});

test("catalog CRUD and product import return row-level results with tenant-scoped idempotency", () => {
  const store = new InMemoryCommerceStore();
  const service = new CommerceService({ store });
  const one = context("ten_one");
  const two = context("ten_two");
  const category = service.createCategory(one, { name: "Drinks" });
  const input = {
    rows: [
      { name: "Tea", sku: "TEA-001", price: "12.50", currency: "USD", category_id: category.id, image: "tea.png", description: "Green tea" },
      { name: "Broken", sku: "BAD-001", price: "12.999", currency: "USD" },
      { name: "Duplicate", sku: "TEA-001", price: "9.00", currency: "USD" }
    ],
    idempotency_key: "product-import-key-001"
  };
  const result = service.importProducts(one, input);
  assert.deepEqual(
    { imported: result.imported, updated: result.updated, failed: result.failed, total: result.total },
    { imported: 1, updated: 0, failed: 2, total: 3 }
  );
  assert.equal(result.errors[0].row, 2);
  assert.equal(result.errors[0].code, "COMMERCE_INVALID_REQUEST");
  assert.equal(result.errors[1].code, "COMMERCE_DUPLICATE_SKU");
  assert.equal(result.products[0].product.price_minor, 1250);
  assert.equal(service.importProducts(one, input).products[0].product.id, result.products[0].product.id);
  assert.equal(service.listProducts(two).total, 0);
  assert.equal(service.listCategories(one).items[0].name, "Drinks");
  assert.equal(service.updateCategory(one, category.id, { name: "Beverages" }).name, "Beverages");
  assert.equal(service.updateProduct(one, result.products[0].product.id, { description: "Updated" }).description, "Updated");
  expectCode("COMMERCE_NOT_FOUND", () => service.updateProduct(two, result.products[0].product.id, { name: "Nope" }));
  const invalidImport = service.importProducts(one, {
    rows: [{ name: "No SKU", price: "1.00", currency: "USD" }],
    idempotency_key: "product-import-key-002"
  });
  assert.equal(invalidImport.failed, 1);
  assert.equal(invalidImport.errors[0].code, "COMMERCE_INVALID_REQUEST");
});
