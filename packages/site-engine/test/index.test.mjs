import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { SiteEngineService, SiteEngineError } from "../src/index.mjs";

const schema = JSON.parse(await readFile(new URL("../../../contracts/site-schema/v1/examples/golden-path.json", import.meta.url)));
const context = (tenant_id = "ten_pet_store") => ({ schema_version: "1.0", tenant_id, actor_id: "usr_owner", actor_type: "user", roles: ["tenant_owner"], scopes: ["site:read", "site:publish"], trace_id: "4bf92f3577b34da6a3ce929d0e0e4736", request_origin: { kind: "merchant_console", request_id: "req_100" } });
const resolver = { resolveAsset: async (ctx, id) => ({ id, tenant_id: ctx.tenant_id }), resolveProduct: async (ctx, id) => ({ id, tenant_id: ctx.tenant_id }), resolveCategory: async (ctx, id) => ({ id, tenant_id: ctx.tenant_id }) };

test("preview and publish expose renderer metadata and immutable versions", async () => {
  const engine = new SiteEngineService({ resolver });
  const preview = await engine.preview(context(), schema);
  assert.deepEqual(preview.metadata.responsive, ["mobile", "tablet", "desktop"]);
  const first = await engine.publish(context(), schema);
  const second = await engine.publish(context(), { ...schema, name: "Updated" });
  assert.notEqual(first.version_id, second.version_id);
  assert.equal(engine.getPublished(context(), schema.site_id).version_id, second.version_id);
  assert.equal(engine.store.getVersion(first.version_id).schema_json.name, "Paw & Whisker");
});

test("rollback creates a new publication without mutating history", async () => {
  const engine = new SiteEngineService({ resolver });
  const first = await engine.publish(context(), schema);
  await engine.publish(context(), { ...schema, name: "Updated" });
  const rollback = engine.rollback(context(), schema.site_id, first.version_id);
  assert.notEqual(rollback.version_id, first.version_id);
  assert.equal(rollback.rollback_of, first.version_id);
  assert.equal(engine.getPublished(context(), schema.site_id).schema_json.name, "Paw & Whisker");
  assert.equal(engine.listVersions(context(), schema.site_id).length, 3);
});

test("tenant isolation applies to reads and rollback", async () => {
  const engine = new SiteEngineService({ resolver });
  const version = await engine.publish(context(), schema);
  assert.throws(() => engine.getPublished(context("ten_other"), schema.site_id), (error) => error instanceof SiteEngineError && error.code === "SITE_NOT_FOUND");
  assert.throws(() => engine.rollback(context(), schema.site_id, "version_foreign"), (error) => error.code === "SITE_VERSION_NOT_FOUND");
  assert.ok(engine.audit.every((entry) => entry.tenant_id === "ten_pet_store" && entry.trace_id === context().trace_id));
  assert.ok(version.validation.valid);
});
