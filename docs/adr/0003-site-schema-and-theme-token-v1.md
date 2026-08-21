# ADR-0003: Freeze SiteSchema v1 and ThemeToken v1

- Status: accepted
- Date: 2026-08-21
- Owners: Architect + Site Engine reviewers
- Approved by: project owner
- Related issue: YUC-6

## Context

The MVP needs a predictable React renderer for generated sites without allowing
model output to become runtime code. The Golden Path also needs real,
tenant-owned assets and commerce references, responsive layouts, preview, and
safe publication/rollback.

## Decision

- Freeze `SiteSchema` and `ThemeToken` at contract version `1.0`.
- Use strict JSON Schema objects with closed section and token vocabularies.
- Keep asset, product, and category values as opaque stable IDs resolved under
  `TenantContext`; schema validity does not grant resource ownership.
- Express responsive behavior through fixed breakpoint/layout enums only.
- Store published site data as immutable `SiteVersion` snapshots. Preview has no
  side effects; rollback creates a new publication from an existing snapshot.
- Reject unknown versions, fields, section types, props, token values, unsafe
  text/URLs, and unresolved references.

## Alternatives considered

- Arbitrary component names and props: rejected because model output could load
  unintended components or unsafe behavior.
- Generated HTML/CSS/JavaScript: rejected because the renderer must remain
  controlled and auditable.
- Copying full Product or Asset objects into the schema: rejected because it
  creates stale data and bypasses tenant-scoped ownership checks.
- Mutating the currently published JSON during edits or rollback: rejected
  because it destroys auditability and makes rollback non-deterministic.

## Compatibility and migration

Consumers select a schema by exact `schema_version` and fail closed for unknown
versions. Additive fields or vocabulary require an explicitly negotiated minor
version; structural or semantic changes require a new major version, ADR,
dual-read migration window, and updated examples/tests. Existing `SiteVersion`
records remain immutable and are interpreted with their declared version.
