import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

const contractRoot = new URL("../../contracts/tenant-context/v1/", import.meta.url);

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, contractRoot), "utf8"));
}

const schema = await readJson("tenant-context.schema.json");
const reservedFields = new Set(await readJson("reserved-input-fields.json"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(schema);

const merchantContext = await readJson("examples/merchant-user.json");
const customerContext = await readJson("examples/anonymous-customer.json");
const serviceContext = await readJson("examples/service-workflow.json");

function assertValid(context) {
  assert.equal(validate(context), true, JSON.stringify(validate.errors, null, 2));
}

function assertInvalid(context) {
  assert.equal(validate(context), false, "expected context to fail validation");
}

function acceptToolInput(input) {
  const injected = Object.keys(input).filter((key) => reservedFields.has(key));
  if (injected.length > 0) {
    return { accepted: false, reason: "reserved_context_field" };
  }
  return { accepted: true };
}

function decideTenantResourceAccess(context, resourceTenantId) {
  if (!context || !validate(context)) {
    return "deny_invalid_context";
  }
  if (!resourceTenantId || resourceTenantId !== context.tenant_id) {
    return "deny_not_visible";
  }
  return "allow";
}

test("normative examples validate", () => {
  assertValid(merchantContext);
  assertValid(customerContext);
  assertValid(serviceContext);
});

test("missing tenant context fields fail closed", () => {
  const missingTenant = structuredClone(merchantContext);
  delete missingTenant.tenant_id;
  assertInvalid(missingTenant);

  const missingScopes = structuredClone(merchantContext);
  delete missingScopes.scopes;
  assertInvalid(missingScopes);
});

test("unknown fields, duplicate scopes and malformed traces are rejected", () => {
  assertInvalid({ ...merchantContext, debug_override: true });
  assertInvalid({ ...merchantContext, scopes: ["site:read", "site:read"] });
  assertInvalid({ ...merchantContext, scopes: ["site:read", "root:everything"] });
  assertInvalid({ ...merchantContext, trace_id: "tr_not_w3c" });
  assertInvalid({ ...merchantContext, trace_id: "00000000000000000000000000000000" });
});

test("actor type, role and origin combinations are consistent", () => {
  assertInvalid({ ...customerContext, roles: ["tenant_owner"] });
  assertInvalid({
    ...customerContext,
    request_origin: { ...customerContext.request_origin, kind: "public_api" }
  });
  assertInvalid({ ...serviceContext, roles: ["tenant_admin"] });
  assertInvalid({
    ...serviceContext,
    request_origin: { ...serviceContext.request_origin, kind: "merchant_console" }
  });
});

test("model or Tool input cannot override trusted identity and trace fields", () => {
  assert.deepEqual(acceptToolInput({ site_id: "site_pet_store", title: "New title" }), {
    accepted: true
  });
  assert.deepEqual(acceptToolInput({ tenant_id: "ten_other", title: "Spoof" }), {
    accepted: false,
    reason: "reserved_context_field"
  });
  assert.deepEqual(acceptToolInput({ trace_id: "ffffffffffffffffffffffffffffffff" }), {
    accepted: false,
    reason: "reserved_context_field"
  });
  assert.deepEqual(acceptToolInput({ scopes: ["site:publish"] }), {
    accepted: false,
    reason: "reserved_context_field"
  });
});

test("reference repository decision denies missing and cross-tenant access", () => {
  assert.equal(decideTenantResourceAccess(merchantContext, "ten_pet_store"), "allow");
  assert.equal(decideTenantResourceAccess(merchantContext, "ten_competitor"), "deny_not_visible");
  assert.equal(decideTenantResourceAccess(undefined, "ten_pet_store"), "deny_invalid_context");
  assert.equal(decideTenantResourceAccess(merchantContext, undefined), "deny_not_visible");
});

test("optional site and project identifiers cannot carry nested caller data", () => {
  assertInvalid({ ...merchantContext, site_id: { id: "site_pet_store", tenant_id: "ten_other" } });
  assertInvalid({ ...merchantContext, project_id: "project with spaces" });
});
