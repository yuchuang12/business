# ADR-0004: Freeze ToolContract v1 and Error Taxonomy

- Status: accepted
- Date: 2026-08-21
- Owners: Architect + Agent Runtime reviewers
- Approved by: project owner
- Related issue: YUC-7

## Context

Every Agent side effect needs one auditable, tenant-aware boundary. Without a
common envelope, tools would diverge on authorization, approvals, retries,
deduplication, and error handling, and provider details could leak to callers.

## Decision

- Freeze `ToolContract` at version `1.0` with strict request and response
  envelopes.
- Carry a compact `TenantContext` reference and trusted `trace_id`; resolve and
  validate the full context out of band at the Executor boundary.
- Require typed tool input from the registry, an idempotency key, and audit
  linkage on every response.
- Use the registry error code table and fixed categories/retry policy.
- Scope idempotency by tenant, tool name/version, and key; replay equal hashes
  and reject conflicting payloads.
- Require a valid, exact, unexpired approval for policy-classified high-risk
  actions.

## Alternatives considered

- Letting each tool define its own envelope was rejected because callers could
  not safely compose tools or handle failures consistently.
- Embedding provider response objects was rejected because it leaks secrets and
  couples the public protocol to vendors.
- Treating an approval ID as sufficient was rejected because approval must be
  bound to the exact actor, input, and idempotency context.
- Retrying with a new idempotency key was rejected because it can duplicate
  external side effects.

## Consequences

Tools gain predictable validation, replay, observability, and user-safe errors.
The Executor and registry must maintain canonical request hashing, approval
records, and redacted audit writes. Tool-specific schemas remain necessary and
are intentionally outside this common contract.

## Compatibility and migration

Unknown versions and fields fail closed. Additive non-security changes require
a negotiated minor version. Required-field, error, approval, idempotency, or
security changes require a new major version, ADR, migration window, and
conformance tests. Existing records retain their declared version.
