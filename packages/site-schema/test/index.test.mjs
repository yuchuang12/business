import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { SiteSchemaError, validateSiteSchema, resolveReferences } from "../src/index.mjs";

const golden = JSON.parse(await readFile(new URL("../../../../contracts/site-schema/v1/examples/golden-path.json", import.meta.url)));
const context = { schema_version: "1.0", tenant_id: "ten_pet_store", actor_id: "usr_owner", actor_type: "user", roles: ["tenant_owner"], scopes: ["site:read", "site:publish"], trace_id: "4bf92f3577b34da6a3ce929d0e0e4736", request_origin: { kind: "merchant_console", request_id: "req_100" } };
const expectCode = (fn, code) => assert.throws(fn, (error) => error instanceof SiteSchemaError && error.code === code);

test("validates the Golden Path schema", () => assert.deepEqual(validateSiteSchema(golden), golden));
test("fails closed for unknown sections and unsafe props", () => {
  const unknown = structuredClone(golden); unknown.pages[0].sections[0].type = "runtime_component"; expectCode(() => validateSiteSchema(unknown), "SITE_SCHEMA_UNKNOWN_SECTION");
  const unsafe = structuredClone(golden); unsafe.pages[0].sections[0].props.headline = "<script>alert(1)</script>"; expectCode(() => validateSiteSchema(unsafe), "SITE_SCHEMA_UNSAFE");
  const brokenLink = structuredClone(golden); brokenLink.navigation[0].destination.page_id = "page_missing"; expectCode(() => validateSiteSchema(brokenLink), "SITE_REFERENCE_UNRESOLVED");
});
test("resolves references only inside the context tenant", async () => {
  const resolver = { resolveAsset: async (ctx, id) => ({ id, tenant_id: ctx.tenant_id }), resolveProduct: async (ctx, id) => ({ id, tenant_id: ctx.tenant_id }), resolveCategory: async () => ({ id: "foreign", tenant_id: "other" }) };
  await assert.rejects(() => resolveReferences(context, golden, resolver), (error) => error.code === "SITE_REFERENCE_UNRESOLVED");
});
