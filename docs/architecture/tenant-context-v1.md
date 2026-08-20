# TenantContext v1 Architecture

- Status: proposed
- Contract: `contracts/tenant-context/v1/tenant-context.schema.json`
- Related issue: YUC-5

## Purpose and invariants

`TenantContext` is the mandatory security boundary for application, Agent, Tool, workflow, repository, audit, and provider operations. It carries the authenticated tenant and initiating actor; it is not a caller-editable DTO.

The following invariants are normative:

- No business data operation runs without a Schema-valid trusted context.
- There is no default tenant, privileged fallback, or optional tenant filter.
- The LLM, API body, Tool input, workflow payload, and Provider response cannot set or replace security fields.
- The initiating actor remains stable while an Agent or workflow acts on the actor's behalf. Execution identities belong to AgentRun/ToolExecution/Audit records, not in a rewritten actor field.
- `trace_id` stays unchanged across the logical operation. Local spans may add span ids without replacing the trace id.
- Every referenced resource is resolved inside `context.tenant_id`; an ID by itself never proves ownership.

## Construction and propagation

```text
Untrusted request / event
          |
          v
API Gateway or trusted task ingress
  - authenticate principal
  - verify tenant membership / service grant
  - assign trusted origin + request_id
  - accept or create validated trace_id
          |
          v  immutable TenantContext (out of band)
Application service / Agent Runtime
          |
          +----> Prompt/model receives minimum business data only
          |
          v
Policy -> Tool Registry -> Tool Executor
          |
          +----> AuditLog (security fields + outcome, redacted)
          |
          v
Workflow -> Repository/DAO -> tenant-scoped database operation
          |
          v
Provider adapter (only minimum required metadata + trace correlation)
```

### API Gateway / trusted ingress

- Authenticate the user session, API credential, webhook signature, scheduled job, or service principal.
- Resolve `tenant_id`, `actor_id`, roles, and scopes from authoritative identity and membership records. A tenant identifier in a route is only a selector and must match an authorized membership.
- Assign `request_origin.kind` from the listener configuration and generate `request_origin.request_id`; never trust body/query values for either field.
- Reuse a syntactically valid inbound W3C trace id only under the observability policy; otherwise generate one. Trace values are correlation data and never authorization evidence.
- Validate the finished object before entering application code. Any failure terminates the request or job.

### Application, Agent and Tool boundaries

- Treat the context as immutable request-scoped state or an explicit function parameter. Do not expose a setter.
- Agent prompts may receive tenant-owned business records needed for the task but do not receive roles, scopes, credentials, or a mutable serialized context.
- Tool invocation has two channels: trusted `TenantContext` supplied by the Executor and typed business input supplied by the model/caller. Security fields listed in `reserved-input-fields.json` in the business input cause deterministic rejection.
- Policy evaluates the required scope and resource ownership before execution. The Tool rechecks tenant ownership at its repository boundary; it must not rely only on an earlier Agent decision.

### Workflow and asynchronous boundaries

- A queue or workflow record stores the exact versioned context snapshot plus a stable workflow/run identifier for audit and replay diagnosis.
- On each start or resume, a trusted worker validates the snapshot, reloads the principal's current status and effective authorization, and constructs a fresh execution context with the original tenant, actor, trace and origin correlation.
- Revoked membership, disabled service principal, expired approval or changed resource ownership fails closed. A persisted role/scope snapshot cannot revive revoked permission.
- Retries preserve `trace_id`; each attempt gets its own span and execution/audit identifier.

## Repository/DAO enforcement

Every business repository method requires `TenantContext` as its first argument. Forbidden shapes include `findById(id)`, `save(entityWithCallerTenant)` and `list(optionalTenantId)`.

Required behavior:

```text
read:   WHERE tenant_id = context.tenant_id AND id = requested_id
insert: tenant_id := context.tenant_id (ignore/reject caller tenant fields)
update: WHERE tenant_id = context.tenant_id AND id = requested_id
delete: WHERE tenant_id = context.tenant_id AND id = requested_id
join:   every tenant-owned relation must agree with context.tenant_id
```

- Tenant scoping must be present in the issued database query, not only in application-side filtering.
- IDs such as `site_id`, `product_id`, `asset_id` and `category_id` must be resolved under the context tenant before use.
- A cross-tenant identifier returns the same external not-visible result as a missing identifier to avoid existence disclosure. Audit records retain an internal mismatch reason without returning the foreign tenant id.
- Administrative cross-tenant operations are outside MVP. Future support requires a separate, explicit privileged contract and ADR; it cannot bypass `TenantContext v1`.
- Each repository implementation must add integration tests for matching tenant, different tenant, missing context, caller-supplied tenant, and cross-tenant foreign references.

## Failure behavior

| Condition | Required outcome |
| --- | --- |
| Missing context | Reject before business logic. |
| Unsupported version or invalid Schema | Reject; do not normalize to a permissive default. |
| Unknown role/scope/origin or inconsistent actor combination | Reject at validation/construction. |
| Caller/model supplies a reserved security field | Reject the Tool invocation; never merge the field. |
| Referenced resource belongs to another tenant | Deny as not visible; write a redacted audit reason. |
| Actor or service authorization was revoked during a workflow | Do not resume execution; require a newly authorized request. |
| `site_id` or `project_id` disagrees with authoritative ownership | Deny; the optional context hint never overrides stored ownership. |

The public error envelope and stable error code mapping are owned by ToolContract v1 (YUC-7). This contract fixes the security outcome without pre-empting that taxonomy.

## Audit, logging and provider rules

Every security-sensitive operation records structured, tenant-scoped audit data containing at least contract version, `tenant_id`, `actor_id`, `actor_type`, `trace_id`, origin kind, action, target type/id, policy decision, outcome, and the AgentRun/ToolExecution/workflow identifiers when present.

- Never log credentials, cookies, tokens, webhook secrets, raw prompts, uploaded documents, full Tool payloads, or Provider secret material.
- Application logs use identifiers and normalized result categories. Roles/scopes may be recorded in the immutable audit decision snapshot but should not be repeated in general logs.
- Authorization failures are redacted externally. Logs and traces must not reveal another tenant's identity or resource data.
- Provider adapters receive only fields required by that provider plus trace correlation where supported. Do not serialize the full context into Provider requests.
- Audit writes are part of the operation's required outcome. If the action cannot be audited reliably, security-sensitive side effects fail closed.

## Verification plan

The contract suite validates positive examples, malformed and inconsistent contexts, reserved-field injection, and a reference cross-tenant decision. Each implementation must additionally provide database integration tests proving that tenant predicates are present for reads and writes. The P0 security suite will later exercise cross-tenant API, Agent, Tool, workflow recovery, and provider paths end to end.
