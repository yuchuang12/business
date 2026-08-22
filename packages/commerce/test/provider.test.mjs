import assert from "node:assert/strict";
import test from "node:test";
import { CommerceProviderClient, CommerceService, FakeCommerceProvider, InMemoryCommerceStore, ProviderError } from "../src/index.mjs";

const context = {
  schema_version: "1.0", tenant_id: "tenant_provider", actor_id: "actor_provider",
  actor_type: "user", roles: ["tenant_owner"], scopes: ["product:read", "cart:write", "order:write"],
  trace_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  request_origin: { kind: "merchant_console", request_id: "request_provider_001" }
};

test("fake provider lookup is tenant-scoped and carries no credential data", async () => {
  const provider = new FakeCommerceProvider({ products: [{ id: "provider_product_1", name: "Tea", price_minor: 1200 }] });
  const service = new CommerceService({ store: new InMemoryCommerceStore(), provider });
  const product = await service.lookupProductFromProvider(context, { product_id: "provider_product_1", site_id: "site_1" });
  assert.equal(product.tenant_id, context.tenant_id);
  assert.equal(provider.calls[0].tenant_id, context.tenant_id);
  assert.doesNotMatch(JSON.stringify(provider.calls), /token|secret|credential/);
});

test("approved provider order is idempotent and requires approval", async () => {
  const provider = new FakeCommerceProvider();
  const service = new CommerceService({
    store: new InMemoryCommerceStore(), provider,
    approvalValidator: (approval) => approval.status === "approved"
  });
  const cart = service.createCart(context);
  const product = service.createProduct(context, { name: "Tea", price_minor: 1200 });
  await service.addToCart(context, { cart_id: cart.id, product_id: product.id, quantity: 1, idempotency_key: "provider-cart-key-001" });
  await assert.rejects(
    service.createApprovedProviderOrder(context, { cart_id: cart.id, idempotency_key: "provider-order-key-001" }),
    (error) => error.code === "COMMERCE_APPROVAL_REQUIRED"
  );
  const input = { cart_id: cart.id, idempotency_key: "provider-order-key-001", approval_reference: { id: "approval_1", status: "approved" } };
  const first = await service.createApprovedProviderOrder(context, input);
  const replay = await service.createApprovedProviderOrder(context, input);
  assert.equal(replay.provider_order_id, first.provider_order_id);
  assert.equal(provider.calls.filter(({ operation }) => operation === "createOrder").length, 1);
});

test("unknown in-flight order is reconciled without a duplicate provider call", async () => {
  const provider = new FakeCommerceProvider();
  let calls = 0;
  provider.createOrder = async () => {
    calls += 1;
    throw new ProviderError("COMMERCE_PROVIDER_TIMEOUT", "timeout", { retryable: true, unknownInFlight: true });
  };
  provider.reconcileOrder = async () => ({ provider_order_id: "provider_order_reconciled", status: "accepted" });
  const service = new CommerceService({
    store: new InMemoryCommerceStore(), provider, approvalValidator: () => true
  });
  const cart = service.createCart(context);
  const product = service.createProduct(context, { name: "Tea", price_minor: 1200 });
  await service.addToCart(context, { cart_id: cart.id, product_id: product.id, quantity: 1, idempotency_key: "provider-cart-key-002" });
  const result = await service.createApprovedProviderOrder(context, {
    cart_id: cart.id, idempotency_key: "provider-order-key-002", approval_reference: { id: "approval_2", status: "approved" }
  });
  assert.equal(result.provider_order_id, "provider_order_reconciled");
  assert.equal(calls, 1);
});

test("http provider retries rate limits and sends tenant-safe correlation headers", async () => {
  let calls = 0;
  const requests = [];
  const provider = new CommerceProviderClient({
    baseUrl: "https://provider.invalid/api/",
    credentialResolver: async (requestContext) => ({ tenant_id: requestContext.tenant_id, reference: "credential_1", token: "secret-token" }),
    fetchImpl: async (url, request) => {
      calls += 1;
      requests.push({ url: String(url), request });
      return calls === 1
        ? { status: 429, ok: false }
        : { status: 200, ok: true, json: async () => ({ id: "provider_product_1", name: "Tea", price_minor: 1200 }) };
    },
    sleep: async () => {}
  });
  const product = await provider.getProduct(context, { product_id: "provider_product_1", site_id: "site_1" });
  assert.equal(product.tenant_id, context.tenant_id);
  assert.equal(calls, 2);
  assert.equal(requests[0].request.headers["x-tenant-id"], context.tenant_id);
  assert.equal(requests[0].request.headers["x-trace-id"], context.trace_id);
  assert.equal(requests[0].request.headers.authorization, "Bearer secret-token");
});
