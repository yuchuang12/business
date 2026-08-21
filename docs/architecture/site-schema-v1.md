# SiteSchema v1 and ThemeToken v1

- Status: accepted
- Contracts: `contracts/site-schema/v1/site-schema.schema.json`,
  `contracts/theme-token/v1/theme-token.schema.json`
- Related issue: YUC-6
- Decision record: `docs/adr/0003-site-schema-and-theme-token-v1.md`

## Renderer boundary

The Site Engine accepts only a validated `SiteSchema` plus trusted,
tenant-scoped resolved records. It maps the closed `type` union to registered
React components. It never imports a component by name from input, evaluates
JavaScript, parses HTML, or interpolates schema strings into CSS.

Reference resolution is a separate application step. `asset_id`, `product_ids`,
and `category_id` are resolved with `TenantContext v1`; missing or
cross-tenant references fail publication and preview rather than being replaced
with generated data.

## Extension rules

New section types, props, tokens, presets, breakpoints, or reference kinds are
contract changes. They require a schema version, example, migration/compatibility
decision, and conformance tests. A renderer may add an internal component
implementation only when it is already represented by the frozen schema.

## Lifecycle

Draft edits produce a newly validated snapshot. Preview is read-only. Publish
stores an immutable `SiteVersion` and points the site to that version. Rollback
creates a new publication from a prior immutable version, preserving the full
publication history. Validation, reference resolution, safety checks, and link
checks happen before publication.
