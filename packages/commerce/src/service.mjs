import { assertBusinessInput, requireTenantContext } from "./context.mjs";
import { CommerceError, fail } from "./errors.mjs";
import { TenantRepository } from "./repository.mjs";
import { ProviderError } from "./provider.mjs";

function hash(value) {
  if (Array.isArray(value)) return `[${value.map(hash).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${hash(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function requireScope(context, ...scopes) {
  if (!scopes.some((scope) => context.scopes.includes(scope))) {
    fail("COMMERCE_FORBIDDEN", "The actor is not authorized for this commerce operation.");
  }
}

const CURRENCY = /^[A-Z]{3}$/;
const ZERO_DECIMAL_CURRENCIES = new Set(["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);

function validateCurrency(currency) {
  if (typeof currency !== "string" || !CURRENCY.test(currency)) {
    fail("COMMERCE_INVALID_REQUEST", "Currency must be an uppercase ISO 4217 code.");
  }
  return currency;
}

function parsePrice(value, currency) {
  const digits = ZERO_DECIMAL_CURRENCIES.has(currency) ? 0 : 2;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || Math.round(value * (10 ** digits)) !== value * (10 ** digits)) {
      fail("COMMERCE_INVALID_REQUEST", "Price format is invalid.");
    }
    return Math.round(value * (10 ** digits));
  }
  if (typeof value !== "string") fail("COMMERCE_INVALID_REQUEST", "Price format is invalid.");
  const normalized = value.trim();
  const pattern = digits === 0 ? /^\d+$/ : /^\d+(?:\.\d{1,2})?$/;
  if (!pattern.test(normalized)) fail("COMMERCE_INVALID_REQUEST", "Price format is invalid.");
  const [whole, fraction = ""] = normalized.split(".");
  return Number(whole) * (10 ** digits) + Number((fraction + "0".repeat(digits)).slice(0, digits));
}

function normalizeProductInput(input, { requireSku = false } = {}) {
  assertBusinessInput(input);
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const sku = typeof input.sku === "string" ? input.sku.trim() : "";
  if (!name || (requireSku && !sku)) fail("COMMERCE_INVALID_REQUEST", "Product name and SKU are required.");
  const currency = validateCurrency(input.currency ?? "USD");
  const priceMinor = input.price_minor !== undefined
    ? (Number.isInteger(input.price_minor) && input.price_minor >= 0 ? input.price_minor : null)
    : parsePrice(input.price, currency);
  if (priceMinor === null) fail("COMMERCE_INVALID_REQUEST", "price_minor must be a non-negative integer.");
  return { ...input, name, sku, currency, price_minor: priceMinor };
}

function ensureUniqueSku(service, context, sku, excludingId) {
  if (!sku) return;
  const duplicate = service.repositories.products.list(context, {
    page: 1, pageSize: 100,
    filter: (product) => product.sku === sku && product.id !== excludingId
  }).items[0];
  if (duplicate) fail("COMMERCE_DUPLICATE_SKU", "SKU is already used by another product.");
}

export class CommerceService {
  constructor({ store, approvalValidator = () => true, provider } = {}) {
    if (!store) fail("COMMERCE_INVALID_REQUEST", "A commerce store is required.");
    this.store = store;
    this.approvalValidator = approvalValidator;
    this.provider = provider;
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
  createCategory(context, input = {}) {
    const trusted = requireTenantContext(context);
    requireScope(trusted, "product:write", "commerce:write");
    assertBusinessInput(input);
    if (typeof input.name !== "string" || !input.name.trim()) fail("COMMERCE_INVALID_REQUEST", "Category name is required.");
    return this.#create(trusted, "categories", { ...input, name: input.name.trim() }, "category");
  }
  createAsset(context, input = {}) { return this.#create(context, "assets", input, "asset"); }
  createCustomer(context, input = {}) { return this.#create(context, "customers", input, "customer"); }

  createProduct(context, input = {}) {
    const trusted = requireTenantContext(context);
    const normalized = normalizeProductInput(input);
    ensureUniqueSku(this, trusted, normalized.sku);
    if (normalized.category_id) this.repositories.categories.get(trusted, normalized.category_id);
    return this.#create(trusted, "products", { ...normalized, canonical_id: undefined }, "product");
  }

  updateProduct(context, productId, changes = {}) {
    const trusted = requireTenantContext(context);
    requireScope(trusted, "product:write", "commerce:write");
    const current = this.repositories.products.get(trusted, productId);
    const normalized = normalizeProductInput({
      name: current.name, sku: current.sku, price_minor: current.price_minor,
      currency: current.currency, description: current.description, image: current.image,
      category_id: current.category_id, ...changes
    });
    ensureUniqueSku(this, trusted, normalized.sku, productId);
    if (normalized.category_id) this.repositories.categories.get(trusted, normalized.category_id);
    const product = this.repositories.products.update(trusted, productId, { ...normalized, canonical_id: undefined });
    this.#audit(trusted, "product.update", product, "accepted");
    return product;
  }

  updateCategory(context, categoryId, changes = {}) {
    const trusted = requireTenantContext(context);
    requireScope(trusted, "product:write", "commerce:write");
    assertBusinessInput(changes);
    if (changes.name !== undefined && (typeof changes.name !== "string" || !changes.name.trim())) {
      fail("COMMERCE_INVALID_REQUEST", "Category name is required.");
    }
    const category = this.repositories.categories.update(trusted, categoryId, {
      ...changes, ...(changes.name ? { name: changes.name.trim() } : {})
    });
    this.#audit(trusted, "category.update", category, "accepted");
    return category;
  }

  getProduct(context, productId) {
    return this.get(context, "products", productId);
  }

  getCategory(context, categoryId) {
    return this.get(context, "categories", categoryId);
  }

  listProducts(context, options = {}) {
    return this.lookupProducts(context, options);
  }

  listCategories(context, options = {}) {
    const trusted = requireTenantContext(context);
    requireScope(trusted, "product:read", "commerce:read");
    return this.repositories.categories.list(trusted, options);
  }

  importProducts(context, { rows, idempotency_key: key } = {}) {
    const trusted = requireTenantContext(context);
    requireScope(trusted, "product:write", "commerce:write");
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > 1000 ||
        typeof key !== "string" || key.length < 16) {
      fail("COMMERCE_INVALID_REQUEST", "Import rows and an idempotency key are required.");
    }
    const scope = `${trusted.tenant_id}:product.import:${key}`;
    const requestHash = hash(rows);
    const prior = this.store.idempotency.get(scope);
    if (prior) {
      if (prior.request_hash !== requestHash) fail("COMMERCE_CONFLICT", "Idempotency key was already used with different input.");
      return structuredClone(prior.response);
    }

    const seen = new Set();
    const result = {
      imported: 0, updated: 0, failed: 0, total: rows.length,
      success_count: 0, failure_count: 0, errors: [], products: []
    };
    rows.forEach((row, index) => {
      try {
        assertBusinessInput(row);
        const normalized = normalizeProductInput(row, { requireSku: true });
        if (seen.has(normalized.sku)) fail("COMMERCE_DUPLICATE_SKU", "SKU is duplicated in the import.");
        seen.add(normalized.sku);
        if (normalized.category_id) this.repositories.categories.get(trusted, normalized.category_id);
        const existing = this.repositories.products.list(trusted, {
          page: 1, pageSize: 100, filter: (product) => product.sku === normalized.sku
        }).items[0];
        const product = existing
          ? this.updateProduct(trusted, existing.id, { ...normalized, id: undefined })
          : (ensureUniqueSku(this, trusted, normalized.sku), this.#create(trusted, "products", { ...normalized, canonical_id: undefined }, "product"));
        if (existing) result.updated += 1; else result.imported += 1;
        result.success_count += 1;
        result.products.push({ row: index + 1, product });
      } catch (error) {
        if (!(error instanceof CommerceError)) throw error;
        result.failed += 1;
        result.failure_count += 1;
        result.errors.push({ row: index + 1, code: error.code, category: error.category, message: error.message });
      }
    });
    this.store.idempotency.set(scope, { request_hash: requestHash, response: result });
    this.#audit(trusted, "product.import", null, result.failed ? "partial" : "accepted", {
      imported: result.imported, updated: result.updated, failed: result.failed
    });
    return structuredClone(result);
  }

  importProductRows(context, input = {}) {
    return this.importProducts(context, input);
  }

  lookupProducts(context, { query = "", category_id, page = 1, page_size: pageSize = 20 } = {}) {
    const trusted = requireTenantContext(context);
    requireScope(trusted, "product:read", "commerce:read");
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

  async lookupProductFromProvider(context, { product_id: productId, site_id: siteId } = {}) {
    const trusted = requireTenantContext(context);
    requireScope(trusted, "product:read", "commerce:read");
    if (!this.provider || typeof this.provider.getProduct !== "function") {
      fail("COMMERCE_PROVIDER_UNAVAILABLE", "A commerce provider is not configured.");
    }
    try {
      const product = await this.provider.getProduct(trusted, { product_id: productId, site_id: siteId });
      if (!product || product.tenant_id !== trusted.tenant_id) {
        fail("COMMERCE_PROVIDER_FAILED", "Provider returned an invalid product.");
      }
      this.#audit(trusted, "product.provider_lookup", null, "accepted");
      return structuredClone(product);
    } catch (error) {
      if (error instanceof CommerceError) throw error;
      if (error instanceof ProviderError) {
        this.#audit(trusted, "product.provider_lookup", null, "rejected", { code: error.code });
        fail(error.unknownInFlight ? "COMMERCE_UNKNOWN_IN_FLIGHT" : error.code, "Commerce provider request failed.");
      }
      throw error;
    }
  }

  getCartSummary(context, cartId) {
    const trusted = requireTenantContext(context);
    requireScope(trusted, "cart:write", "commerce:read", "commerce:write");
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
    requireScope(trusted, "cart:write", "commerce:write");
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

  removeFromCart(context, { cart_id: cartId, product_id: productId, idempotency_key: key } = {}) {
    const trusted = requireTenantContext(context);
    requireScope(trusted, "cart:write", "commerce:write");
    if (typeof productId !== "string" || typeof key !== "string" || key.length < 16) {
      fail("COMMERCE_INVALID_REQUEST", "Cart item and idempotency key are required.");
    }
    const scope = `${trusted.tenant_id}:cart.remove:${key}`;
    const requestHash = hash({ cartId, productId });
    const prior = this.store.idempotency.get(scope);
    if (prior) {
      if (prior.request_hash !== requestHash) fail("COMMERCE_CONFLICT", "Idempotency key was already used with different input.");
      return structuredClone(prior.response);
    }
    const cart = this.repositories.carts.get(trusted, cartId);
    const items = (cart.items ?? []).filter((item) => item.product_id !== productId);
    const updated = this.repositories.carts.update(trusted, cart.id, { items });
    this.store.idempotency.set(scope, { request_hash: requestHash, response: updated });
    this.#audit(trusted, "cart.remove", updated, "accepted", { product_id: productId });
    return updated;
  }

  updateCartItem(context, { cart_id: cartId, product_id: productId, quantity, idempotency_key: key } = {}) {
    const trusted = requireTenantContext(context);
    requireScope(trusted, "cart:write", "commerce:write");
    if (typeof productId !== "string" || !Number.isInteger(quantity) || quantity < 0 ||
        typeof key !== "string" || key.length < 16) {
      fail("COMMERCE_INVALID_REQUEST", "Cart item quantity and idempotency key are required.");
    }
    const scope = `${trusted.tenant_id}:cart.update:${key}`;
    const requestHash = hash({ cartId, productId, quantity });
    const prior = this.store.idempotency.get(scope);
    if (prior) {
      if (prior.request_hash !== requestHash) fail("COMMERCE_CONFLICT", "Idempotency key was already used with different input.");
      return structuredClone(prior.response);
    }
    const cart = this.repositories.carts.get(trusted, cartId);
    const items = [...(cart.items ?? [])];
    const index = items.findIndex((item) => item.product_id === productId);
    if (index < 0) fail("COMMERCE_NOT_FOUND", "Cart item is not visible.");
    if (quantity === 0) items.splice(index, 1); else items[index] = { ...items[index], quantity };
    const updated = this.repositories.carts.update(trusted, cart.id, { items });
    this.store.idempotency.set(scope, { request_hash: requestHash, response: updated });
    this.#audit(trusted, "cart.update", updated, "accepted", { product_id: productId, quantity });
    return updated;
  }

  recommendationCandidates(context, { query = "", category_id, product_ids, page = 1, page_size: pageSize = 20 } = {}) {
    const trusted = requireTenantContext(context);
    requireScope(trusted, "product:read", "commerce:read");
    if (product_ids !== undefined && (!Array.isArray(product_ids) || product_ids.some((id) => typeof id !== "string"))) {
      fail("COMMERCE_INVALID_REQUEST", "Recommendation product_ids are invalid.");
    }
    const result = this.lookupProducts(trusted, { query, category_id, page, page_size: pageSize });
    if (product_ids) {
      const requested = new Set(product_ids);
      result.items = result.items.filter((product) => requested.has(product.product_id));
      result.total = result.items.length;
      result.has_next = false;
    }
    this.#audit(trusted, "product.recommendation_candidates", null, "accepted", { count: result.items.length });
    return result;
  }

  getRecommendationCandidates(context, input = {}) {
    return this.recommendationCandidates(context, input);
  }

  captureLead(context, input = {}) {
    const trusted = requireTenantContext(context);
    requireScope(trusted, "lead:write", "commerce:write");
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

  createLead(context, input = {}) {
    return this.captureLead(context, input);
  }

  createCart(context, input = {}) {
    const trusted = requireTenantContext(context);
    requireScope(trusted, "cart:write", "commerce:write");
    if (input.customer_id) this.repositories.customers.get(trusted, input.customer_id);
    return this.#create(trusted, "carts", { ...input, items: input.items ?? [] }, "cart");
  }

  createOrder(context, { cart_id: cartId, idempotency_key: key, approval_reference: approval } = {}) {
    const trusted = requireTenantContext(context);
    requireScope(trusted, "order:write", "commerce:write");
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

  async createApprovedProviderOrder(context, { cart_id: cartId, idempotency_key: key, approval_reference: approval } = {}) {
    const trusted = requireTenantContext(context);
    requireScope(trusted, "order:write", "commerce:write");
    if (!this.provider || typeof this.provider.createOrder !== "function") {
      fail("COMMERCE_PROVIDER_UNAVAILABLE", "A commerce provider is not configured.");
    }

    if (typeof key !== "string" || key.length < 16) fail("COMMERCE_INVALID_REQUEST", "Order idempotency key is required.");
    const cart = this.repositories.carts.get(trusted, cartId);
    const summary = this.getCartSummary(trusted, cart.id);
    if (!approval || !this.approvalValidator(approval, trusted, { cart_id: cart.id, idempotency_key: key })) {
      this.#audit(trusted, "provider.order.create", cart, "rejected", { code: "COMMERCE_APPROVAL_REQUIRED" });
      fail("COMMERCE_APPROVAL_REQUIRED", "Approval is required for provider order creation.");
    }
    const scope = `${trusted.tenant_id}:provider.order.create:${key}`;
    const requestHash = hash({ cart_id: cart.id, items: summary.items, total_minor: summary.total_minor, approval_reference: approval });
    const prior = this.store.idempotency.get(scope);
    if (prior) {
      if (prior.request_hash !== requestHash) fail("COMMERCE_CONFLICT", "Idempotency key was already used with different input.");
      return structuredClone(prior.response);
    }
    try {
      const result = await this.provider.createOrder(trusted, {
        cart_id: cart.id, items: summary.items, total_minor: summary.total_minor,
        currency: summary.currency, idempotency_key: key
      });
      const response = { ...result, cart_id: cart.id, status: result.status ?? "accepted" };
      this.store.idempotency.set(scope, { request_hash: requestHash, response });
      this.#audit(trusted, "provider.order.create", response, "accepted");
      return structuredClone(response);
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      if (error.unknownInFlight && typeof this.provider.reconcileOrder === "function") {
        const reconciled = await this.provider.reconcileOrder(trusted, { idempotency_key: key });
        if (reconciled) {
          const response = { ...reconciled, cart_id: cart.id, status: reconciled.status ?? "accepted" };
          this.store.idempotency.set(scope, { request_hash: requestHash, response });
          this.#audit(trusted, "provider.order.reconcile", response, "accepted");
          return structuredClone(response);
        }
      }
      this.#audit(trusted, "provider.order.create", cart, "rejected", { code: error.unknownInFlight ? "COMMERCE_UNKNOWN_IN_FLIGHT" : error.code });
      fail(error.unknownInFlight ? "COMMERCE_UNKNOWN_IN_FLIGHT" : error.code, "Commerce provider request failed.");
    }
  }

  createOrderIntent(context, input = {}) {
    return this.createOrder(context, input);
  }

  get(context, resource, id) { return this.repositories[resource].get(requireTenantContext(context), id); }
}
