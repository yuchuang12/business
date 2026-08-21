# ADR-0003: Establish TenantContext v1 as an out-of-band security context

- Status: accepted
- Date: 2026-08-21
- Owners: Architect + Backend + Agent Runtime reviewers
- Approved by: 于闯（项目所有者，2026-08-21）
- Related issues: YUC-5, YUC-7, YUC-8

## Context

The MVP requires tenant isolation across API, Agent, Tool, workflow, repository, audit, and Provider operations. If tenant or actor identity is accepted in ordinary request/model payloads, an untrusted caller or LLM can attempt to replace authorization state. Long-running workflows also need replayable audit context without reviving revoked permissions.

## Decision

- Define `TenantContext v1` as a versioned, immutable object constructed only at authenticated ingress.
- Keep tenant, actor, role, scope, trace, and origin fields out of business/model/Tool input and propagate the context through a separate trusted channel.
- Preserve the initiating actor while Agents, Tools, and workflows act on that actor's behalf; record execution identities in their own lifecycle/audit records.
- Use a W3C-compatible 32-hex-character `trace_id` for end-to-end correlation.
- Require explicit Repository/DAO context and tenant predicates for every business read and write; cross-tenant identifiers fail as not visible.
- Persist a versioned context snapshot for asynchronous audit, but re-resolve current principal authorization before each start or resume.
- Reject unknown versions, fields, roles, scopes, origins, and inconsistent actor combinations by default.

## Alternatives considered

- Accept `tenant_id` and `actor_id` in each Tool payload: rejected because untrusted model input would share a merge boundary with authorization state.
- Store tenant context only in ambient thread-local state: rejected because asynchronous workflows and tests need explicit, serializable propagation; repository APIs also need a visible mandatory dependency.
- Trust the persisted workflow snapshot until completion: rejected because membership, service grants and approvals can be revoked while a workflow is paused.
- Return an explicit cross-tenant authorization error: rejected at the resource boundary because it leaks the existence of another tenant's identifier.
- Allow arbitrary role/scope strings for forward compatibility: rejected for v1 because unknown authorization vocabulary must fail closed; new values require explicit version negotiation.

## Consequences

- API Gateway, Agent Runtime, Tool Executor, workflows, repositories and Provider adapters share one security invariant and trace identity.
- ToolContract v1 must model trusted context separately from model-authored `input` and must reject reserved security fields.
- Repository implementations require tenant-scoped method signatures and integration tests; generic unscoped helpers cannot be used for business data.
- Workflow resume requires an identity/authorization refresh and can stop after permission revocation.
- Adding roles, scopes or origins requires a new compatible contract version rather than silently widening authority.

## Compatibility and migration

This is the first version, so no existing contract data needs migration. Consumers must validate the exact declared version. Additive vocabulary or optional fields require a new minor Schema and explicit consumer support; incompatible structural or semantic changes require a new major version, ADR, dual-read migration period, and updated conformance tests. Audit snapshots remain immutable and are interpreted using the Schema version stored with them.
