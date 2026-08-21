const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const TRACE = /^[0-9a-f]{32}$/;
const TEXT = /^[^<>\u0000-\u001f]*$/;
const URL = /^https:\/\/.+/;
const SECTIONS = new Set(["hero", "product_grid", "category", "faq", "review", "story", "cta", "footer", "header", "feature_list", "image_text", "rich_text"]);
const RESERVED = new Set(["tenant_id", "actor_id", "actor_type", "roles", "scopes", "trace_id", "request_origin", "site_id", "project_id"]);
const SECTION_PROPS = {
  hero: ["headline", "subheadline", "asset", "action"],
  product_grid: ["product_ids", "category_id", "limit", "title"],
  category: ["category_id", "title", "asset"],
  faq: ["source", "items", "title"],
  review: ["reviews", "title"],
  story: ["title", "body", "asset"],
  cta: ["headline", "body", "action"],
  footer: ["copyright", "links"],
  header: ["logo", "show_navigation"],
  feature_list: ["title", "items"],
  image_text: ["title", "body", "asset", "image_position"],
  rich_text: ["body", "title"]
};

export class SiteSchemaError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "SiteSchemaError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new SiteSchemaError(code, message, details);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("SITE_SCHEMA_INVALID", `${label} must be an object.`);
  return value;
}

function keys(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail("SITE_SCHEMA_UNSAFE", `Unknown ${label} field: ${key}.`);
}

function text(value, label, max = 500) {
  if (typeof value !== "string" || value.length < 1 || value.length > max || !TEXT.test(value)) fail("SITE_SCHEMA_UNSAFE", `${label} must be safe plain text.`);
}

function id(value, label) {
  if (typeof value !== "string" || !ID.test(value)) fail("SITE_SCHEMA_INVALID", `${label} must be an opaque identifier.`);
}

function reference(value, label) {
  object(value, label);
  keys(value, new Set(["asset_id", "alt", "focal_point"]), label);
  id(value.asset_id, `${label}.asset_id`);
  if (value.alt !== undefined) text(value.alt, `${label}.alt`);
  if (value.focal_point !== undefined) {
    object(value.focal_point, `${label}.focal_point`);
    keys(value.focal_point, new Set(["x", "y"]), `${label}.focal_point`);
    for (const axis of ["x", "y"]) if (typeof value.focal_point[axis] !== "number" || value.focal_point[axis] < 0 || value.focal_point[axis] > 1) fail("SITE_SCHEMA_INVALID", `${label}.focal_point.${axis} is invalid.`);
  }
}

function destination(value, label) {
  object(value, label);
  keys(value, new Set(["page_id", "url"]), label);
  if (value.page_id !== undefined) id(value.page_id, `${label}.page_id`);
  else if (value.url !== undefined) {
    if (typeof value.url !== "string" || !URL.test(value.url)) fail("SITE_SCHEMA_UNSAFE", `${label}.url must use https.`);
  } else fail("SITE_SCHEMA_INVALID", `${label} needs a page_id or https url.`);
}

function action(value, label) {
  object(value, label);
  keys(value, new Set(["label", "destination"]), label);
  text(value.label, `${label}.label`);
  destination(value.destination, `${label}.destination`);
}

function theme(theme) {
  object(theme, "theme");
  keys(theme, new Set(["schema_version", "preset", "colors", "typography", "spacing", "radius", "density"]), "theme");
  if (theme.schema_version !== "1.0" || !["minimal", "tech", "premium", "natural", "vibrant"].includes(theme.preset)) fail("SITE_SCHEMA_VERSION_UNSUPPORTED", "ThemeToken v1 is required.");
  object(theme.colors, "theme.colors");
  keys(theme.colors, new Set(["background", "surface", "text", "muted_text", "primary", "secondary", "accent", "border"]), "theme.colors");
  for (const [name, color] of Object.entries(theme.colors)) if (typeof color !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(color)) fail("SITE_SCHEMA_UNSAFE", `theme.colors.${name} is invalid.`);
  object(theme.typography, "theme.typography");
  keys(theme.typography, new Set(["font_family", "heading_weight", "body_weight", "scale"]), "theme.typography");
  if (typeof theme.typography.font_family !== "string" || !/^[A-Za-z0-9 ,.'-]+$/.test(theme.typography.font_family)) fail("SITE_SCHEMA_UNSAFE", "theme.typography.font_family is invalid.");
  if (![400, 500, 600, 700, 800].includes(theme.typography.heading_weight) || ![400, 500, 600].includes(theme.typography.body_weight) || !["compact", "standard", "large"].includes(theme.typography.scale)) fail("SITE_SCHEMA_INVALID", "Theme typography is invalid.");
  if (!["tight", "standard", "airy"].includes(theme.spacing) || !["none", "sm", "md", "lg", "pill"].includes(theme.radius) || !["compact", "comfortable", "spacious"].includes(theme.density)) fail("SITE_SCHEMA_INVALID", "Theme layout tokens are invalid.");
}

function validateProps(type, props) {
  object(props, `${type}.props`);
  keys(props, new Set(SECTION_PROPS[type]), `${type}.props`);
  const required = { hero: ["headline"], product_grid: ["limit"], category: ["category_id"], faq: ["source"], review: ["reviews"], story: ["title", "body"], cta: ["headline", "action"], footer: ["copyright"], feature_list: ["items"], image_text: ["title", "body", "asset"], rich_text: ["body"] }[type] ?? [];
  for (const key of required) if (props[key] === undefined) fail("SITE_SCHEMA_INVALID", `${type}.props.${key} is required.`);
  for (const [key, value] of Object.entries(props)) {
    if (["headline", "subheadline", "title", "body", "copyright"].includes(key)) text(value, `${type}.props.${key}`);
    if (["asset", "logo"].includes(key)) reference(value, `${type}.props.${key}`);
    if (key === "action") action(value, `${type}.props.action`);
    if (key === "limit" && (!Number.isInteger(value) || value < 1 || value > 24)) fail("SITE_SCHEMA_INVALID", "Product limit is invalid.");
    if (key.endsWith("_id")) id(value, `${type}.props.${key}`);
    if (key === "product_ids") { if (!Array.isArray(value) || value.length < 1 || value.length > 24) fail("SITE_SCHEMA_INVALID", "product_ids is invalid."); value.forEach((item) => id(item, "product_ids item")); }
  }
  if (type === "product_grid" && !props.product_ids && !props.category_id) fail("SITE_SCHEMA_INVALID", "product_grid needs product_ids or category_id.");
  if (type === "faq" && !["knowledge", "curated"].includes(props.source)) fail("SITE_SCHEMA_INVALID", "FAQ source is invalid.");
}

function section(value) {
  object(value, "section");
  keys(value, new Set(["id", "type", "layout", "props"]), "section");
  id(value.id, "section.id");
  if (!SECTIONS.has(value.type)) fail("SITE_SCHEMA_UNKNOWN_SECTION", `Unknown section type: ${value.type}.`);
  validateProps(value.type, value.props);
  if (value.layout !== undefined) {
    object(value.layout, "section.layout");
    keys(value.layout, new Set(["container", "responsive"]), "section.layout");
    if (value.layout.container !== undefined && !["full", "wide", "standard", "narrow"].includes(value.layout.container)) fail("SITE_SCHEMA_INVALID", "Invalid layout container.");
  }
}

function assertSafeStrings(value, path = "schema") {
  if (typeof value === "string" && !TEXT.test(value)) fail("SITE_SCHEMA_UNSAFE", `${path} contains unsafe text.`);
  if (Array.isArray(value)) value.forEach((item, index) => assertSafeStrings(item, `${path}[${index}]`));
  else if (value && typeof value === "object") Object.entries(value).forEach(([key, child]) => assertSafeStrings(child, `${path}.${key}`));
}

export function validateTenantContext(context) {
  object(context, "TenantContext");
  keys(context, new Set(["schema_version", "tenant_id", "actor_id", "actor_type", "roles", "scopes", "trace_id", "request_origin", "site_id", "project_id"]), "TenantContext");
  if (context.schema_version !== "1.0" || !ID.test(context.tenant_id) || !ID.test(context.actor_id) || !TRACE.test(context.trace_id) || /^0+$/.test(context.trace_id)) fail("TENANT_CONTEXT_INVALID", "A valid TenantContext v1 is required.");
  if (!["user", "customer_session", "service_principal"].includes(context.actor_type) || !Array.isArray(context.roles) || !Array.isArray(context.scopes) || !context.roles.length || !context.scopes.length || new Set(context.roles).size !== context.roles.length || new Set(context.scopes).size !== context.scopes.length) fail("TENANT_CONTEXT_INVALID", "TenantContext identity is invalid.");
  object(context.request_origin, "request_origin");
  if (typeof context.request_origin.request_id !== "string" || !ID.test(context.request_origin.request_id)) fail("TENANT_CONTEXT_INVALID", "request_origin is invalid.");
  if (context.site_id !== undefined) id(context.site_id, "site_id");
  if (context.project_id !== undefined) id(context.project_id, "project_id");
  return structuredClone(context);
}

export function validateSiteSchema(schema) {
  object(schema, "SiteSchema");
  keys(schema, new Set(["schema_version", "site_id", "name", "default_locale", "theme", "navigation", "pages", "seo"]), "SiteSchema");
  if (schema.schema_version !== "1.0") fail("SITE_SCHEMA_VERSION_UNSUPPORTED", "SiteSchema v1 is required.");
  id(schema.site_id, "site_id"); text(schema.name, "name"); theme(schema.theme);
  if (!Array.isArray(schema.navigation) || schema.navigation.length < 1) fail("SITE_SCHEMA_INVALID", "navigation is required.");
  const pageIds = new Set();
  for (const page of schema.pages ?? []) {
    object(page, "page"); keys(page, new Set(["page_id", "slug", "title", "sections", "seo"]), "page"); id(page.page_id, "page_id");
    if (pageIds.has(page.page_id)) fail("SITE_SCHEMA_INVALID", `Duplicate page_id: ${page.page_id}.`);
    pageIds.add(page.page_id); text(page.title, "page.title");
    if (typeof page.slug !== "string" || !/^\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\/?)*$/.test(page.slug) || !Array.isArray(page.sections) || page.sections.length < 1) fail("SITE_SCHEMA_INVALID", "Page slug or sections are invalid.");
    page.sections.forEach(section);
    object(page.seo, "page.seo"); text(page.seo.title, "page.seo.title"); text(page.seo.description, "page.seo.description", 160);
  }
  if (!schema.pages?.length) fail("SITE_SCHEMA_INVALID", "At least one page is required.");
  for (const item of schema.navigation) { object(item, "navigation item"); keys(item, new Set(["id", "label", "destination"]), "navigation item"); id(item.id, "navigation.id"); text(item.label, "navigation.label"); destination(item.destination, "navigation.destination"); }
  object(schema.seo, "seo"); text(schema.seo.title, "seo.title"); text(schema.seo.description, "seo.description", 160);
  const pageRefs = [];
  const collectPageRefs = (value) => {
    if (!value || typeof value !== "object") return;
    if (value.page_id) pageRefs.push(value.page_id);
    Object.values(value).forEach(collectPageRefs);
  };
  collectPageRefs(schema);
  for (const pageId of pageRefs) if (!pageIds.has(pageId)) fail("SITE_REFERENCE_UNRESOLVED", `Page reference is not visible: ${pageId}.`);
  assertSafeStrings(schema);
  return structuredClone(schema);
}

export function collectReferences(schema) {
  const refs = { assets: new Set(), products: new Set(), categories: new Set() };
  const visit = (value, type) => {
    if (!value || typeof value !== "object") return;
    if (value.asset_id) refs.assets.add(value.asset_id);
    if (value.category_id) refs.categories.add(value.category_id);
    if (Array.isArray(value.product_ids)) value.product_ids.forEach((idValue) => refs.products.add(idValue));
    Object.values(value).forEach((child) => visit(child, type));
  };
  visit(schema, "schema");
  return refs;
}

export async function resolveReferences(context, schema, resolver) {
  validateTenantContext(context);
  const validated = validateSiteSchema(schema);
  if (!resolver) fail("SITE_REFERENCE_UNRESOLVED", "A tenant-scoped reference resolver is required.");
  const refs = collectReferences(validated);
  const resolved = { assets: {}, products: {}, categories: {} };
  for (const idValue of refs.assets) resolved.assets[idValue] = await resolve(resolver, "asset", context, idValue);
  for (const idValue of refs.products) resolved.products[idValue] = await resolve(resolver, "product", context, idValue);
  for (const idValue of refs.categories) resolved.categories[idValue] = await resolve(resolver, "category", context, idValue);
  return { schema: validated, ...resolved };
}

async function resolve(resolver, kind, context, idValue) {
  const method = resolver[`resolve${kind[0].toUpperCase()}${kind.slice(1)}`];
  if (typeof method !== "function") fail("SITE_REFERENCE_UNRESOLVED", `Resolver does not support ${kind} references.`);
  const value = await method.call(resolver, context, idValue);
  if (!value || value.tenant_id !== context.tenant_id) fail("SITE_REFERENCE_UNRESOLVED", `${kind} reference is not visible.`);
  return structuredClone(value);
}

export { RESERVED };
