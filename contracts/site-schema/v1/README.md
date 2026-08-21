# SiteSchema v1

- Contract version: `1.0`
- Schema: `site-schema.schema.json`
- Status: frozen
- Related issue: YUC-6
- Decision record: `docs/adr/0003-site-schema-and-theme-token-v1.md`

`SiteSchema` is the only input accepted by the Site Engine. It is a versioned,
data-only document containing site metadata, navigation, pages, SEO, theme tokens,
and a closed catalog of 12 section types:

`hero`, `product_grid`, `category`, `faq`, `review`, `story`, `cta`, `footer`,
`header`, `feature_list`, `image_text`, and `rich_text`.

All `asset_id`, `product_id`, and `category_id` values are opaque references. The
tenant-scoped application service must resolve every reference before rendering;
the schema does not imply that an identifier exists or belongs to the current
tenant. Unknown section types, props, fields, URLs, HTML-like text, and arbitrary
layout/CSS values are rejected.

Responsive behavior is expressed only through the fixed `mobile`, `tablet`, and
`desktop` layout tokens. The renderer owns the breakpoint implementation and must
never evaluate schema values as code or CSS.

### Version and lifecycle semantics

- Drafts may be edited only by creating a new validated document.
- A `SiteVersion` stores the exact immutable `schema_json`, `theme_json`, author,
  and validation result. Published versions are never updated in place.
- Publish creates a new immutable published version after reference resolution,
  schema validation, content safety, and link checks.
- Rollback selects a prior immutable published version and creates a new
  publication record pointing to that exact data; it does not mutate history.
- Preview renders a validated draft snapshot with no publication side effects.
- Unknown schema versions fail closed. Additive fields, vocabulary, or semantics
  require a new negotiated minor version; incompatible changes require a new major
  version and ADR. Stored versions remain interpretable using their declared
  schema version.
