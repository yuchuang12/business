# ToolContract v1

- Contract version: `1.0`
- Schema: `tool-contract.schema.json`
- Error registry: `error-codes.json`
- Status: frozen
- Related issue: YUC-7
- Decision record: `docs/adr/0004-tool-contract-v1.md`

`ToolContract` is the only common wire envelope for Agent-callable tools. The
tool registry owns each tool's typed input/output schema; the common envelope
does not contain provider fields. The Executor supplies the trusted
`TenantContext` out of band and validates the compact `tenant_context_ref`
against it. `trace_id` must equal the trusted context trace id.

## Request

Requests contain an exact tool name/version, context reference, W3C-compatible
trace id, idempotency key, and an object validated by the registered tool
schema. `approval_reference` is an opaque approval record/version; its presence
does not itself authorize execution.

Policy derives whether a tool is high risk from the registry and current
TenantContext. A high-risk request must have an approval reference whose record
is valid, unexpired, tenant/actor/tool/input-bound, and approved for the exact
idempotency key. Missing, expired, mismatched, or revoked approvals return
`TOOL_APPROVAL_REQUIRED` or `TOOL_APPROVAL_EXPIRED` and never execute side
effects.

## Response and errors

Success has `success: true`, non-null `data`, `error: null`, and
`retryable: false`. Failure has `success: false`, `data: null`, and a
machine-actionable registered error. Messages are safe for user presentation;
provider responses, credentials, raw prompts, and secret-bearing details must
never be copied into the envelope. `audit_id` is always required, including
validation and authorization failures. `tool_execution_id` is present once an
execution record exists.

The registry maps each code to one stable category and retry policy. Callers
must branch on `code`/`retryable`, not message text. `validation`,
`authorization`, `approval`, `conflict`, and `not_found` are not retryable.
`rate_limit`, `provider`, `timeout`, and `transient_infrastructure` are
retryable subject to bounded backoff and the same idempotency key. `internal`
is non-retryable unless an explicitly registered operational policy says
otherwise.

## Idempotency and lifecycle

The key is scoped to `(tenant_id, tool_name, tool_version, idempotency_key)`.
The Executor atomically claims it before side effects and retains the
canonical request hash and response for at least 24 hours (or the tool's
longer declared retention). A duplicate with the same hash replays the
original response and audit identifiers without executing again. A duplicate
with a different canonical input or context hash returns `TOOL_CONFLICT`.
Retries and approval-gated resumes retain the same key and `trace_id`; attempts
get distinct execution/audit records.

The lifecycle is: validate envelope and typed input -> resolve trusted context
-> policy and approval check -> idempotency claim -> execute once -> record
redacted audit -> return response. Retryable failures may retry with the same
claim. Workflows compensate only when the registered tool declares a
compensation action; compensation is separately audited and idempotent.
Observability records tenant-safe identifiers, tool/version, trace, outcome,
latency, retry count, and audit/execution IDs.

## Compatibility

Consumers select the exact `contract_version` and fail closed for unknown
versions and fields. Additive non-security metadata may be introduced only in
a negotiated minor version. Changes to required fields, error meaning,
idempotency scope, approval semantics, or security behavior require a new major
version, ADR, migration window, and conformance tests. Existing audit and
idempotency records remain interpreted using their declared version.

Normative examples cover success, validation failure, retryable provider
failure, and approval-gated execution. The contract tests also verify replay
and conflicting-payload decisions.
