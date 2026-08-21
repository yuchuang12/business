import { assertBusinessInput, requireTenantContext } from "./context.mjs";
import { fail } from "./errors.mjs";
import { TenantRepository } from "./repository.mjs";

function hash(value) {
  if (Array.isArray(value)) return `[${value.map(hash).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${hash(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export class CommerceService {
  constructor({ store, approvalValidator = () => true } = {}) {
    if (!store) fail("COMMERCE_INVALID_REQUEST", "A commerce store is required.");
    this.store = store;
    this.approvalValidator = approvalValidator;
    this.repositories = Object.fromEntries([
      ["merchants", "merchant"], ["sites", "site"], ["products", "product"], ["categories", "category"],
      ["assets", "asset"], ["customers", "customer"], ["carts", "cart"], ["orders", "order"], ["leads", "lead"]
    ].map(([table, prefix]) => [table, new TenantRepository(store, table, prefix)]));
  }

  #audit(context, action, target, outcome, details = {}) {
    this.store.recordAudit({ audit_id: `audit_${crypto.randomUUID().replaceAll("-", "")}`, contract_version: "1.0", tenant_id: context.tenant_id, actor_id: context.actor_id, trace_id: context.trace_id, action, target_type: target?.type ?? "commerce", target_id: target?.id ?? null, outcome, details, created_at: new Date().toISOString() });
  }

  #create(context, table, input, type) {
    const trusted = requireTenantContext(context);
    const record = this.repositories[table].create(trusted, input, { type });
    this.#audit(trusted, `${type}.create`, record, "accepted");
    return record;
  }

  createMerchant(context, input = {}) { return this.#create(context, "merchants", input, "merchant"); }
  createSite(context, input = {}) {
    const trusted = requireTenantContext(context);
    if (input.merchant_id) this.repositories.merchants.get(trusted, input.merchant_id);
    return this.#create(trusted, "sites", input, "site");
  }
  createCategory(context, input = {}) { return this.#create(context, "categories", input, "category"); }
  createAsset(context, input = {}) { return this.#create(context, "assets", input, "asset"); }
  createCustomer(context, input = {}) { return this.#create(context, "customers", input, "customer"); }

  createProduct(context, input = {}) {
    if (!input.name || typeof input.name !== "string" || typeof input.price_minor !== "number" || input.price_minor < 0) {
      fail("COMMERCE_INVALID_REQUEST", "Product name and non-negative price_minor are required.");
    }
    const trusted = requireTenantContext(context);
    if (input.category_id) this.repositories.categories.get(trusted, input.category_id);
    return this.#create(trusted, "products", { ...input, canonical_id: undefined }, "product");
  }

  lookupProducts(context, { query = "", category_id, page = 1, page_size: pageSize = 20 } = {}) {
    const trusted = requireTenantContext(context);
    if (typeof query !== "string" || (category_id !== undefined && typeof category_id !== "string")) fail("COMMERCE_INVALID_REQUEST", "Product lookup filters are invalid.");
    const result = this.repositories.products.list(trusted, {
      page, pageSize,
      filter: (product) => (!query || `${product.name} ${product.description ?? ""}`.toLowerCase().includes(query.toLowerCase())) &&
        (!category_id || product.category_id === category_id)
    });
    result.items = result.items.map(({ id, canonical_id, name, description, price_minor, currency, category_id: categoryId, sku, ...rest }) => ({
      product_id: canonical_id ?? id, name, description: description ?? null, price_minor, currency: currency ?? "USD", category_id: categoryId ?? null, sku: sku ?? null, ...rest
    }));
    this.#audit(trusted, "product.lookup", null, "accepted", { count: result.items.length });
    return result;
  }

  getCartSummary(context, cartId) {
    const trusted = requireTenantContext(context);
    const cart = this.repositories.carts.get(trusted, cartId);
    const items = (cart.items ?? []).map((item) => {
      const product = this.repositories.products.get(trusted, item.product_id);
      return { product_id: product.canonical_id ?? product.id, quantity: item.quantity, unit_price_minor: product.price_minor, line_total_minor: product.price_minor * item.quantity, name: product.name };
    });
    const summary = { cart_id: cart.id, items, total_minor: items.reduce((total, item) => total + item.line_total_minor, 0), currency: cart.currency ?? "USD" };
    this.#audit(trusted, "cart.summary", cart, "accepted");
    return summary;
  }

  addToCart(context, { cart_id: cartId, product_id: productId, quantity = 1, idempotency_key: key } = {}) {
    const trusted = requireTenantContext(context);
    if (!Number.isInteger(quantity) || quantity < 1 || typeof key !== "string" || key.length < 16) fail("COMMERCE_INVALID_REQUEST", "Cart item and idempotency key are required.");
    const product = this.repositories.products.get(trusted, productId);
    const scope = `${trusted.tenant_id}:cart.add:${key}`;
    const requestHash = hash({ cartId, productId, quantity });
    const prior = this.store.idempotency.get(scope);
    if (prior) {
      if (prior.request_hash !== requestHash) fail("COMMERCE_CONFLICT", "Idempotency key was already used with different input.");
      return structuredClone(prior.response);
    }
    const cart = this.repositories.carts.get(trusted, cartId);
    const items = [...(cart.items ?? [])];
    const existing = items.find((item) => item.product_id === product.id);
    if (existing) existing.quantity += quantity; else items.push({ product_id: product.id, quantity });
    const updated = this.repositories.carts.update(trusted, cart.id, { items });
    this.store.idempotency.set(scope, { request_hash: requestHash, response: updated });
    this.#audit(trusted, "cart.add", updated, "accepted", { product_id: product.id });
    return updated;
  }

  captureLead(context, input = {}) {
    const trusted = requireTenantContext(context);
    assertBusinessInput(input);
    if (typeof input.email !== "string" && typeof input.phone !== "string") fail("COMMERCE_INVALID_REQUEST", "A lead requires email or phone.");
    const key = input.idempotency_key;
    if (typeof key !== "string" || key.length < 16) fail("COMMERCE_INVALID_REQUEST", "A lead idempotency key is required.");
    const scope = `${trusted.tenant_id}:lead.capture:${key}`;
    const requestHash = hash({ email: input.email, phone: input.phone, product_ids: input.product_ids ?? [], summary: input.summary ?? "" });
    const prior = this.store.idempotency.get(scope);
    if (prior) {
      if (prior.request_hash !== requestHash) fail("COMMERCE_CONFLICT", "Idempotency key was already used with different input.");
      return structuredClone(prior.response);
    }
    const lead = this.repositories.leads.create(trusted, { ...input, idempotency_key: undefined }, { type: "lead" });
    this.store.idempotency.set(scope, { request_hash: requestHash, response: lead });
    this.#audit(trusted, "lead.capture", lead, "accepted");
    return lead;
  }

  createCart(context, input = {}) {
    const trusted = requireTenantContext(context);
    if (input.customer_id) this.repositories.customers.get(trusted, input.customer_id);
    return this.#create(trusted, "carts", { ...input, items: input.items ?? [] }, "cart");
  }

  createOrder(context, { cart_id: cartId, idempotency_key: key, approval_reference: approval } = {}) {
    const trusted = requireTenantContext(context);
    if (typeof key !== "string" || key.length < 16) fail("COMMERCE_INVALID_REQUEST", "Order idempotency key is required.");
    const cart = this.repositories.carts.get(trusted, cartId);
    if (!approval || !this.approvalValidator(approval, trusted, { cart_id: cart.id, idempotency_key: key })) {
      this.#audit(trusted, "order.create", cart, "rejected", { code: "COMMERCE_APPROVAL_REQUIRED" });
      fail("COMMERCE_APPROVAL_REQUIRED", "Approval is required for order creation.");
    }
    const scope = `${trusted.tenant_id}:order.create:${key}`;
    const requestHash = hash({ cart_id: cart.id, approval_reference: approval });
    const prior = this.store.idempotency.get(scope);
    if (prior) {
      if (prior.request_hash !== requestHash) fail("COMMERCE_CONFLICT", "Idempotency key was already used with different input.");
      return structuredClone(prior.response);
    }
    const summary = this.getCartSummary(trusted, cart.id);
    const order = this.repositories.orders.create(trusted, { cart_id: cart.id, items: summary.items, total_minor: summary.total_minor, currency: summary.currency, status: "pending_approval", approval_reference: approval }, { type: "order" });
    this.store.idempotency.set(scope, { request_hash: requestHash, response: order });
    this.#audit(trusted, "order.create", order, "accepted");
    return order;
  }

  get(context, resource, id) { return this.repositories[resource].get(requireTenantContext(context), id); }
}
