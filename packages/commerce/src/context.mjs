import { fail } from "./errors.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const TRACE = /^(?!0{32})[0-9a-f]{32}$/;
const ACTOR_TYPES = new Set(["user", "customer_session", "service_principal"]);
const ROLES = new Set(["tenant_owner", "tenant_admin", "merchant_operator", "support_readonly", "customer", "system_service"]);
const SCOPES = new Set([
  "tenant:read", "tenant:write", "site:read", "site:write", "site:publish",
  "product:read", "product:write", "asset:read", "asset:write",
  "knowledge:read", "knowledge:write", "domain:read", "domain:purchase",
  "domain:write", "commerce:read", "commerce:write", "lead:read", "lead:write",
  "agent:run", "ops:read", "ops:retry",
  // Legacy commerce capability aliases used by existing callers.
  "cart:write", "order:write"
]);
const ORIGINS = new Set(["merchant_console", "customer_site", "public_api", "webhook", "scheduled_job", "internal_worker"]);
const RESERVED = new Set(["tenant_id", "actor_id", "actor_type", "roles", "scopes", "trace_id", "request_origin", "site_id", "project_id"]);

export function requireTenantContext(context) {
  const keys = context && typeof context === "object" ? Object.keys(context) : [];
  const validActorCombination =
    (context?.actor_type === "customer_session" && context.roles?.length === 1 && context.roles[0] === "customer" && context.request_origin?.kind === "customer_site") ||
    (context?.actor_type === "service_principal" && context.roles?.length === 1 && context.roles[0] === "system_service" && ["webhook", "scheduled_job", "internal_worker"].includes(context.request_origin?.kind)) ||
    (context?.actor_type === "user" && ["merchant_console", "customer_site", "public_api"].includes(context.request_origin?.kind));
  if (!context || typeof context !== "object" || Array.isArray(context) ||
      keys.some((key) => !["schema_version", "tenant_id", "actor_id", "actor_type", "roles", "scopes", "trace_id", "request_origin", "site_id", "project_id"].includes(key)) ||
      context.schema_version !== "1.0" ||
      !ID.test(context.tenant_id ?? "") || !ID.test(context.actor_id ?? "") ||
      !ACTOR_TYPES.has(context.actor_type) || !TRACE.test(context.trace_id ?? "") ||
      !Array.isArray(context.roles) || context.roles.length === 0 ||
      !Array.isArray(context.scopes) || context.scopes.length === 0 ||
      new Set(context.roles).size !== context.roles.length ||
      new Set(context.scopes).size !== context.scopes.length ||
      context.roles.some((role) => !ROLES.has(role)) ||
      context.scopes.some((scope) => !SCOPES.has(scope)) ||
      !context.request_origin || Object.keys(context.request_origin).some((key) => !["kind", "request_id"].includes(key)) ||
      !ORIGINS.has(context.request_origin.kind) || !ID.test(context.request_origin.request_id ?? "") ||
      !validActorCombination) {
    fail("COMMERCE_INVALID_REQUEST", "A valid TenantContext v1 is required.");
  }
  return Object.freeze(structuredClone(context));
}

export function assertBusinessInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("COMMERCE_INVALID_REQUEST", "Business input must be an object.");
  }
  const injected = Object.keys(input).filter((key) => RESERVED.has(key));
  if (injected.length) {
    fail("COMMERCE_INVALID_REQUEST", "Security fields must be supplied by TenantContext.", { fields: injected });
  }
  return input;
}
