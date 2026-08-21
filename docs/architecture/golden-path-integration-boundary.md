# Golden Path Integration Boundary (v1)

- Status: implementation guidance
- Related issue: YUC-16
- Contracts: `TenantContext v1`, `ToolContract v1`, `AgentRun v1`,
  `ToolExecution v1`

This boundary connects a trusted customer request to canonical commerce data
and an observable Agent run. It composes the accepted v1 contracts; it does
not add fields to them.

## Request lifecycle

```text
trusted ingress
  -> TenantContext v1
  -> Agent Runtime / AgentRun
  -> Tool Executor / ToolContract
  -> Commerce repository
  -> canonical product or approval-backed action
```

1. Trusted ingress authenticates the actor, resolves tenant membership and
   scopes, assigns `request_origin`, and validates `TenantContext`. Request
   bodies and model output never provide security fields.
2. Agent Runtime creates one logical `agent_run_id` and carries the immutable
   `tenant_id`, `actor_id`, and `trace_id` through every tool execution.
3. The Executor validates typed input, policy, idempotency, and approval before
   calling Commerce. A tool receives the trusted context out of band.
4. Commerce resolves `site_id`, `product_id`, cart, and lead identifiers under
   `context.tenant_id`. Returned records are canonical data, not caller-owned
   copies.
5. The caller observes the Tool response and run state. Approval pauses the
   logical run without a provider side effect; approval resumes with the same
   trace and idempotency key.

## Correlation and identifier propagation

| Identifier | Owner | Boundary rule |
| --- | --- | --- |
| `tenant_id` | trusted ingress | Immutable security partition; never taken from tool input. |
| `actor_id` | trusted ingress | Stable initiating actor; Agent/Tool IDs do not replace it. |
| `trace_id` | ingress/run | Preserved across retries, approvals, and canonical results. |
| `agent_run_id` | Agent Runtime | Logical execution parent for all ToolExecution records. |
| `tool_execution_id` | Executor | Distinct per attempt; never used as the logical run ID. |
| `idempotency_key` | caller + Executor | Scoped to tenant and tool version; changed input conflicts. |
| business IDs | Commerce | Resolved under the trusted tenant; an ID alone proves no ownership. |

Timestamps, array positions, generated display IDs, and error messages are not
correlation keys. Retries create a new execution attempt while preserving the
logical run, trace, and idempotency key.

## Canonical-data resolution

- Tenant and actor authorization are resolved at ingress and refreshed on
  asynchronous resume.
- Agent Runtime owns run state and passes only typed business input to the
  Executor.
- The Executor owns schema validation, policy, approval, idempotency, and
  audit linkage.
- Commerce is the source of truth for product, site, cart, lead, approval, and
  action records. Never reconstruct these records from Agent output or UI
  state.
- A foreign or missing resource has the same external `not_found` result.
  Internal audit data may retain the redacted policy reason.

## Fallback and failure behavior

| Boundary failure | Required outcome |
| --- | --- |
| Missing, malformed, or unsupported context | Reject before business logic. |
| Reserved security field in tool input | Deterministic validation failure; no side effect. |
| Foreign tenant resource | Redacted not-found result. |
| Same idempotency key with different input | Conflict; do not execute again. |
| Provider, timeout, or transient infrastructure failure | Retry only when the error taxonomy and budget allow it. |
| Approval required or expired | Pause or reject; never execute while unapproved. |
| Canonical store unavailable | Surface an infrastructure failure; do not fabricate data. |

The local fixtures use deterministic timestamps and fake providers only. They
prove propagation and trust-boundary behavior without changing public protocol
schemas or contacting cloud resources.

## Local verification

Run the complete deterministic Golden Path verification from the repository
root:

```sh
node --test \
  tests/commerce-golden-path.test.mjs \
  tests/e2e/agent-runtime-golden-path.test.mjs \
  tests/e2e/generative-ui-golden-path.test.mjs \
  tests/e2e/golden-path-integration-boundary.test.mjs \
  tests/contracts/*.test.mjs
```

The command uses only local fixtures and fake providers; it does not contact
cloud resources.

## Trust boundaries and acceptance

Untrusted inputs are HTTP payloads, model/tool arguments, approval callbacks,
resource IDs, and retry requests. Trusted data begins only after context
validation, Executor checks, and tenant-scoped Commerce resolution. The
integration is accepted when the focused fixture covers successful lookup,
canonical action approval, retry/idempotency behavior, and cross-tenant and
reserved-field rejection, while the existing contract suite remains green.
