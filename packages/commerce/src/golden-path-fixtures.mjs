const VERSION = "1.0";

export const IDS = Object.freeze({
  tenant: "ten_pet_store",
  site: "site_pet_store",
  product: "product_pet_food",
  cart: "cart_pet_store_customer",
  lead: "lead_pet_store_customer",
  approval: "approval_pet_store_action_001",
  action: "action_pet_store_001"
});

export const ERROR_CODES = Object.freeze({
  INVALID_CONTEXT: "invalid_context",
  INVALID_INPUT: "invalid_input",
  NOT_VISIBLE: "not_visible",
  FORBIDDEN: "forbidden",
  APPROVAL_REQUIRED: "approval_required",
  IDEMPOTENCY_REPLAY: "idempotency_replay"
});

export const FIXTURE_CONTEXT = Object.freeze({
  schema_version: VERSION,
  tenant_id: IDS.tenant,
  actor_id: "customer_session_pet_store",
  actor_type: "customer_session",
  roles: ["customer"],
  scopes: ["site:read", "product:read", "commerce:write", "lead:write"],
  trace_id: "11111111111111111111111111111111",
  request_origin: { kind: "customer_site", request_id: "request_pet_store_001" },
  site_id: IDS.site
});

const PRODUCT = Object.freeze({
  id: IDS.product,
  tenant_id: IDS.tenant,
  site_id: IDS.site,
  sku: "PET-FOOD-001",
  name: "Everyday Pet Food",
  price: 2999,
  currency: "CNY",
  status: "active"
});

const SITE = Object.freeze({
  id: IDS.site,
  tenant_id: IDS.tenant,
  slug: "pet-store",
  status: "published"
});

function failure(code, message = code) {
  return { success: false, data: null, error: { code, message }, retryable: false };
}

function success(data, auditId) {
  return { success: true, data, error: null, retryable: false, audit_id: auditId };
}

function hasScope(context, scope) {
  return Array.isArray(context?.scopes) && context.scopes.includes(scope);
}

function validContext(context) {
  return context?.schema_version === VERSION &&
    typeof context.tenant_id === "string" &&
    typeof context.actor_id === "string" &&
    typeof context.trace_id === "string" &&
    /^[0-9a-f]{32}$/.test(context.trace_id) &&
    context.request_origin?.kind === "customer_site";
}

function assertContext(context) {
  if (!validContext(context)) return failure(ERROR_CODES.INVALID_CONTEXT);
  return null;
}

function rejectReservedInput(input) {
  const reserved = ["tenant_id", "actor_id", "trace_id", "scopes", "roles"];
  return reserved.some((field) => Object.hasOwn(input ?? {}, field));
}

export class CommerceFixture {
  #approvals = new Map();
  #actions = new Map();
  #carts = new Map();
  #leads = new Map();
  #audit = [];

  lookupProduct(context, input = {}) {
    const contextError = assertContext(context);
    if (contextError) return contextError;
    if (context.tenant_id !== PRODUCT.tenant_id) return failure(ERROR_CODES.NOT_VISIBLE);
    if (!hasScope(context, "product:read") || rejectReservedInput(input) ||
        input.product_id !== IDS.product) {
      return failure(input.product_id === IDS.product ? ERROR_CODES.FORBIDDEN : ERROR_CODES.NOT_VISIBLE);
    }
    return success({ product: { ...PRODUCT }, site: { ...SITE } }, this.#auditRecord(context, "product.lookup", IDS.product));
  }

  requestAction(context, input = {}) {
    const contextError = assertContext(context);
    if (contextError) return contextError;
    if (context.tenant_id !== IDS.tenant) return failure(ERROR_CODES.NOT_VISIBLE);
    if (rejectReservedInput(input) || typeof input.idempotency_key !== "string" ||
        !/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotency_key)) {
      return failure(ERROR_CODES.INVALID_INPUT);
    }
    if (input.site_id !== IDS.site || (input.action_type !== "add_to_cart" && input.action_type !== "create_lead")) {
      return failure(ERROR_CODES.NOT_VISIBLE);
    }
    const requiredScope = input.action_type === "add_to_cart" ? "commerce:write" : "lead:write";
    if (!hasScope(context, requiredScope)) return failure(ERROR_CODES.FORBIDDEN);
    if (input.product_id !== IDS.product) return failure(ERROR_CODES.NOT_VISIBLE);

    const existing = [...this.#approvals.values()].find((approval) =>
      approval.tenant_id === context.tenant_id && approval.idempotency_key === input.idempotency_key);
    if (existing) return success({ approval: { ...existing } }, this.#auditRecord(context, "action.replay", existing.id));

    const approval = {
      id: IDS.approval,
      tenant_id: context.tenant_id,
      site_id: IDS.site,
      action_id: IDS.action,
      action_type: input.action_type,
      product_id: IDS.product,
      idempotency_key: input.idempotency_key,
      status: "pending",
      trace_id: context.trace_id
    };
    this.#approvals.set(approval.id, approval);
    return {
      success: false,
      data: { approval: { ...approval } },
      error: { code: ERROR_CODES.APPROVAL_REQUIRED, message: "approval required" },
      retryable: false,
      audit_id: this.#auditRecord(context, "action.request", approval.id),
      requires_approval: true
    };
  }

  approveAction(context, input = {}) {
    const contextError = assertContext(context);
    if (contextError) return contextError;
    if (rejectReservedInput(input) || input.approval_id !== IDS.approval) return failure(ERROR_CODES.NOT_VISIBLE);
    const approval = this.#approvals.get(input.approval_id);
    if (!approval || approval.tenant_id !== context.tenant_id) return failure(ERROR_CODES.NOT_VISIBLE);
    if (approval.status === "approved") {
      return success({ action: { ...this.#actions.get(approval.action_id) } },
        this.#auditRecord(context, "action.replay", approval.action_id));
    }
    approval.status = "approved";
    const action = {
      id: approval.action_id,
      tenant_id: approval.tenant_id,
      site_id: approval.site_id,
      product_id: approval.product_id,
      type: approval.action_type,
      status: "executed",
      trace_id: approval.trace_id
    };
    this.#actions.set(action.id, action);
    if (approval.action_type === "add_to_cart") {
      this.#carts.set(IDS.cart, { id: IDS.cart, tenant_id: approval.tenant_id, site_id: IDS.site, product_ids: [IDS.product] });
    } else {
      this.#leads.set(IDS.lead, { id: IDS.lead, tenant_id: approval.tenant_id, site_id: IDS.site, product_ids: [IDS.product], status: "created" });
    }
    return success({ action: { ...action }, cart: this.#carts.get(IDS.cart), lead: this.#leads.get(IDS.lead) },
      this.#auditRecord(context, "action.execute", action.id));
  }

  #auditRecord(context, operation, targetId) {
    const auditId = `audit_${this.#audit.length + 1}`;
    this.#audit.push({ id: auditId, operation, target_id: targetId, tenant_id: context.tenant_id, trace_id: context.trace_id });
    return auditId;
  }
}
