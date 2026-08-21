import { fail } from "./errors.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const TRACE = /^(?!0{32})[0-9a-f]{32}$/;
const ACTOR_TYPES = new Set(["user", "customer_session", "service_principal"]);
const RESERVED = new Set(["tenant_id", "actor_id", "actor_type", "roles", "scopes", "trace_id", "request_origin", "site_id", "project_id"]);

export function requireTenantContext(context) {
  if (!context || context.schema_version !== "1.0" ||
      !ID.test(context.tenant_id ?? "") || !ID.test(context.actor_id ?? "") ||
      !ACTOR_TYPES.has(context.actor_type) || !TRACE.test(context.trace_id ?? "") ||
      !Array.isArray(context.roles) || context.roles.length === 0 ||
      !Array.isArray(context.scopes) || context.scopes.length === 0 ||
      new Set(context.roles).size !== context.roles.length ||
      new Set(context.scopes).size !== context.scopes.length ||
      !context.request_origin || !ID.test(context.request_origin.request_id ?? "")) {
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
