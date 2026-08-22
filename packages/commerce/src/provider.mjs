import { requireTenantContext } from "./context.mjs";
import { CommerceError } from "./errors.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;

export class ProviderError extends Error {
  constructor(code, message, { retryable = false, unknownInFlight = false } = {}) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.retryable = retryable;
    this.unknownInFlight = unknownInFlight;
  }
}

function validateCredential(credential) {
  if (!credential || typeof credential !== "object" ||
      typeof credential.reference !== "string" || !SAFE_ID.test(credential.reference) ||
      typeof credential.tenant_id !== "string" || !SAFE_ID.test(credential.tenant_id) ||
      typeof credential.token !== "string" || credential.token.length === 0) {
    throw new ProviderError("COMMERCE_PROVIDER_UNAVAILABLE", "Provider credentials are unavailable.");
  }
  return credential;
}

function normalizeProduct(context, product) {
  if (!product || typeof product !== "object" || typeof product.id !== "string" ||
      typeof product.name !== "string" || typeof product.price_minor !== "number") {
    throw new ProviderError("COMMERCE_PROVIDER_FAILED", "Provider returned an invalid product.");
  }
  return {
    product_id: product.id,
    name: product.name,
    description: product.description ?? null,
    price_minor: product.price_minor,
    currency: product.currency ?? "USD",
    sku: product.sku ?? null,
    tenant_id: context.tenant_id
  };
}

export class CommerceProviderClient {
  constructor({
    baseUrl,
    credentialResolver,
    fetchImpl = globalThis.fetch,
    timeoutMs = 5000,
    maxRetries = 2,
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  } = {}) {
    if (!baseUrl || typeof credentialResolver !== "function" || typeof fetchImpl !== "function") {
      throw new CommerceError("COMMERCE_INVALID_REQUEST", "Provider configuration is incomplete.");
    }
    this.baseUrl = new URL(baseUrl);
    this.credentialResolver = credentialResolver;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.now = now;
    this.sleep = sleep;
  }

  async getProduct(context, { product_id: productId, site_id: siteId } = {}) {
    const trusted = requireTenantContext(context);
    if (typeof productId !== "string" || typeof siteId !== "string") {
      throw new CommerceError("COMMERCE_INVALID_REQUEST", "Provider product references are required.");
    }
    const response = await this.#request(trusted, `/products/${encodeURIComponent(productId)}`, {
      method: "GET",
      headers: { "x-commerce-site-id": siteId }
    });
    return normalizeProduct(trusted, response);
  }

  async createOrder(context, { cart_id: cartId, items, total_minor: totalMinor, currency, idempotency_key: key } = {}) {
    const trusted = requireTenantContext(context);
    if (typeof cartId !== "string" || !Array.isArray(items) || typeof totalMinor !== "number" ||
        typeof key !== "string" || key.length < 16) {
      throw new CommerceError("COMMERCE_INVALID_REQUEST", "Provider order input is invalid.");
    }
    const response = await this.#request(trusted, "/orders", {
      method: "POST",
      idempotencyKey: key,
      body: { cart_id: cartId, items, total_minor: totalMinor, currency: currency ?? "USD" }
    });
    if (!response || typeof response.id !== "string") {
      throw new ProviderError("COMMERCE_PROVIDER_FAILED", "Provider returned an invalid order.");
    }
    return { provider_order_id: response.id, status: response.status ?? "accepted" };
  }

  async reconcileOrder(context, { idempotency_key: key } = {}) {
    const trusted = requireTenantContext(context);
    if (typeof key !== "string" || key.length < 16) {
      throw new CommerceError("COMMERCE_INVALID_REQUEST", "Provider order idempotency key is required.");
    }
    const response = await this.#request(trusted, `/orders/by-idempotency/${encodeURIComponent(key)}`, {
      method: "GET"
    });
    return response && typeof response.id === "string"
      ? { provider_order_id: response.id, status: response.status ?? "accepted" }
      : null;
  }

  async #request(context, path, { method, headers = {}, body, idempotencyKey } = {}) {
    const credential = validateCredential(await this.credentialResolver(context));
    if (credential.tenant_id !== context.tenant_id) {
      throw new ProviderError("COMMERCE_PROVIDER_UNAVAILABLE", "Provider credentials are unavailable.");
    }
    const request = {
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${credential.token}`,
        "x-tenant-id": context.tenant_id,
        "x-trace-id": context.trace_id,
        ...headers,
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    };
    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(new URL(path, this.baseUrl), { ...request, signal: controller.signal });
        if (response.status === 429 || response.status >= 500) {
          throw new ProviderError(response.status === 429 ? "COMMERCE_PROVIDER_RATE_LIMITED" : "COMMERCE_PROVIDER_FAILED",
            "Provider is temporarily unavailable.", { retryable: true });
        }
        if (!response.ok) {
          throw new ProviderError(response.status === 404 ? "COMMERCE_NOT_FOUND" : "COMMERCE_PROVIDER_REJECTED",
            "Provider rejected the request.");
        }
        return await response.json();
      } catch (error) {
        lastError = error.name === "AbortError"
          ? new ProviderError("COMMERCE_PROVIDER_TIMEOUT", "Provider request timed out.", { retryable: true, unknownInFlight: method !== "GET" })
          : error instanceof ProviderError
            ? error
            : new ProviderError("COMMERCE_PROVIDER_FAILED", "Provider request failed.", { retryable: true, unknownInFlight: method !== "GET" });
        if (!lastError.retryable || attempt === this.maxRetries) throw lastError;
        await this.sleep(Math.min(1000 * 2 ** attempt, 4000));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }
}

export class FakeCommerceProvider {
  constructor({ products = [], orders = [], failures = [] } = {}) {
    this.products = new Map(products.map((product) => [product.id, structuredClone(product)]));
    this.orders = new Map(orders.map((order) => [order.idempotency_key, structuredClone(order)]));
    this.failures = [...failures];
    this.calls = [];
  }

  async getProduct(context, input) {
    requireTenantContext(context);
    this.calls.push({ operation: "getProduct", tenant_id: context.tenant_id });
    this.#failIfConfigured();
    const product = this.products.get(input.product_id);
    if (!product) throw new ProviderError("COMMERCE_NOT_FOUND", "Provider product is not available.");
    return { product_id: product.id, ...structuredClone(product), tenant_id: context.tenant_id };
  }

  async createOrder(context, input) {
    requireTenantContext(context);
    this.calls.push({ operation: "createOrder", tenant_id: context.tenant_id });
    this.#failIfConfigured();
    const prior = this.orders.get(input.idempotency_key);
    if (prior) return structuredClone(prior);
    const order = { provider_order_id: `provider_order_${this.orders.size + 1}`, status: "accepted" };
    this.orders.set(input.idempotency_key, order);
    return structuredClone(order);
  }

  async reconcileOrder(context, input) {
    requireTenantContext(context);
    return structuredClone(this.orders.get(input.idempotency_key) ?? null);
  }

  #failIfConfigured() {
    const failure = this.failures.shift();
    if (failure) throw failure;
  }
}
