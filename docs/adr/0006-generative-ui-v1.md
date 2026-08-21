# ADR-0006: Freeze GenerativeUI v1

- Status: accepted
- Date: 2026-08-22
- Owners: Architect + Frontend reviewers
- Approved by: project owner
- Related issue: YUC-9

## Context

Merchant and Customer Agents need to return useful product, commerce, lead,
theme, domain, preview, and workflow surfaces without allowing model output to
become executable UI or fabricated business data. The protocol must correlate
with AgentRun and TenantContext, work on mobile, and degrade safely.

## Decision

- Freeze a strict, data-only `GenerativeUI` envelope at version `1.0`.
- Use a closed discriminated component union for ten MVP surfaces.
- Require opaque tenant-scoped references; canonical services hydrate products,
  prices, inventory, assets, carts, sites, workflows, and approvals.
- Require accessibility metadata, explicit loading/empty/error states, fallback
  text, and constrained analytics hooks.
- Represent high-risk actions as approval/action references only. UI events never
  execute a Tool; the Tool Executor remains the sole side-effect boundary.
- Reject unknown fields, component types, versions, unsafe text/URLs, and
  malformed data before rendering.

## Alternatives considered

- Arbitrary component names and props: rejected because model output could load
  unintended components or bypass renderer review.
- Full Product or Cart objects in the payload: rejected because values become
  stale and can cross tenant or authorization boundaries.
- UI callbacks or URLs in the protocol: rejected because they create an
  executable command/injection channel.
- A separate UI approval executor: rejected because it would duplicate and
  weaken the existing ToolContract policy, idempotency, and audit boundary.

## Compatibility and migration

Consumers select a schema by exact `contract_version` and fail closed for
unknown versions. Additive vocabulary or semantic changes require an explicitly
negotiated minor version. Structural or authorization changes require a new
major version, ADR, migration window, and updated examples/tests. Existing
requests remain interpretable by their declared version.
