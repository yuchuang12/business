import { SiteSchemaError, resolveReferences, validateSiteSchema, validateTenantContext } from "../../site-schema/src/index.mjs";

const TERMINAL = new Set(["published"]);
const clone = (value) => structuredClone(value);
const timestamp = () => new Date().toISOString();
const makeId = (prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

export class SiteEngineError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = "SiteEngineError"; this.code = code; this.details = details; }
}

function fail(code, message, details) { throw new SiteEngineError(code, message, details); }

export class InMemorySiteStore {
  constructor() { this.drafts = new Map(); this.versions = new Map(); this.sites = new Map(); this.audit = []; }
  putDraft(draft) { this.drafts.set(`${draft.tenant_id}:${draft.site_id}`, clone(draft)); }
  getDraft(tenantId, siteId) { return this.drafts.get(`${tenantId}:${siteId}`); }
  putVersion(version) { this.versions.set(version.version_id, clone(version)); }
  getVersion(id) { return this.versions.get(id); }
  listVersions(tenantId, siteId) { return [...this.versions.values()].filter((v) => v.tenant_id === tenantId && v.site_id === siteId).map(clone); }
  putSite(site) { this.sites.set(`${site.tenant_id}:${site.site_id}`, clone(site)); }
  getSite(tenantId, siteId) { return this.sites.get(`${tenantId}:${siteId}`); }
}

export class SiteEngineService {
  constructor({ store = new InMemorySiteStore(), resolver, auditLog = store.audit, clock = timestamp } = {}) {
    this.store = store; this.resolver = resolver; this.auditLog = auditLog; this.audit = auditLog; this.clock = clock;
  }

  #context(context) { try { return validateTenantContext(context); } catch (error) { fail(error.code, error.message); } }
  #audit(context, action, target, outcome, details = {}) {
    const entry = { audit_id: makeId("audit"), contract_version: "1.0", tenant_id: context.tenant_id, actor_id: context.actor_id, trace_id: context.trace_id, action, target_type: target?.version_id ? "site_version" : "site", target_id: target?.version_id ?? target?.site_id ?? null, outcome, details, created_at: this.clock() };
    this.auditLog.push(clone(entry));
  }
  #owned(context, siteId) {
    const site = this.store.getSite(context.tenant_id, siteId);
    if (!site) fail("SITE_NOT_FOUND", "Site is not visible in this tenant.");
    return site;
  }
  async #validated(context, schema) {
    try { return await resolveReferences(context, schema, this.resolver); }
    catch (error) { if (error instanceof SiteSchemaError) fail(error.code, error.message, error.details); throw error; }
  }

  async saveDraft(context, schema) {
    context = this.#context(context);
    const resolved = await this.#validated(context, schema);
    const draft = { draft_id: makeId("draft"), tenant_id: context.tenant_id, site_id: resolved.schema.site_id, schema_json: resolved.schema, resolved_references: resolved, status: "draft", updated_at: this.clock(), actor_id: context.actor_id, trace_id: context.trace_id };
    this.store.putDraft(draft);
    this.#audit(context, "site.draft.save", draft, "accepted");
    return clone(draft);
  }

  async preview(context, schema) {
    context = this.#context(context);
    const resolved = await this.#validated(context, schema);
    const result = { site_id: resolved.schema.site_id, schema: resolved.schema, references: resolved, metadata: { mode: "preview", responsive: ["mobile", "tablet", "desktop"], loading: { supported: true }, error: { supported: true }, empty: { supported: true } } };
    this.#audit(context, "site.preview", result, "accepted");
    return clone(result);
  }

  async publish(context, schema) {
    context = this.#context(context);
    const resolved = await this.#validated(context, schema);
    const version = { version_id: makeId("version"), tenant_id: context.tenant_id, site_id: resolved.schema.site_id, schema_version: resolved.schema.schema_version, schema_json: resolved.schema, theme_json: resolved.schema.theme, resolved_references: resolved, status: "published", published_at: this.clock(), published_by: context.actor_id, trace_id: context.trace_id, validation: { valid: true, schema_version: "1.0" } };
    this.store.putVersion(version);
    this.store.putSite({ site_id: version.site_id, tenant_id: context.tenant_id, current_version_id: version.version_id, updated_at: version.published_at });
    this.#audit(context, "site.publish", version, "accepted");
    return clone(version);
  }

  getPublished(context, siteId) {
    context = this.#context(context); const site = this.#owned(context, siteId);
    const version = this.store.getVersion(site.current_version_id);
    if (!version || version.tenant_id !== context.tenant_id) fail("SITE_NOT_FOUND", "Published site is not visible in this tenant.");
    return clone(version);
  }

  listVersions(context, siteId) {
    context = this.#context(context); this.#owned(context, siteId);
    return this.store.listVersions(context.tenant_id, siteId).sort((a, b) => a.published_at.localeCompare(b.published_at));
  }

  rollback(context, siteId, versionId) {
    context = this.#context(context); this.#owned(context, siteId);
    const source = this.store.getVersion(versionId);
    if (!source || source.tenant_id !== context.tenant_id || source.site_id !== siteId || !TERMINAL.has(source.status)) fail("SITE_VERSION_NOT_FOUND", "Version is not visible in this tenant.");
    const version = { ...clone(source), version_id: makeId("version"), status: "published", published_at: this.clock(), published_by: context.actor_id, rollback_of: source.version_id, trace_id: context.trace_id };
    this.store.putVersion(version); this.store.putSite({ site_id: siteId, tenant_id: context.tenant_id, current_version_id: version.version_id, updated_at: version.published_at });
    this.#audit(context, "site.rollback", version, "accepted", { source_version_id: source.version_id });
    return clone(version);
  }
}
