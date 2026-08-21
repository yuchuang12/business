# ToolContract v1 Architecture

- Status: accepted
- Contract: `contracts/tool-contract/v1/tool-contract.schema.json`
- Related issue: YUC-7

The Tool Executor is the sole entry point for Agent side effects. It receives a
trusted `TenantContext` separately from model-generated business input, checks
the compact context reference and trace correlation, then runs the registered
typed tool only after policy, approval, and idempotency checks.

```text
request -> envelope/schema validation -> trusted context resolution
        -> policy + approval -> idempotency claim -> tool execution
        -> redacted audit -> response
```

The common envelope is deliberately provider-neutral. Provider adapters may
use fields inside a registered tool's typed input but must not add fields to
the common request or response. Provider failures are normalized to
`TOOL_PROVIDER_FAILED`; credentials, raw provider payloads, prompts, and
secrets are excluded from messages and details.

High-risk classification is a registry/policy decision, never a caller input.
For such actions, the Executor requires an approval record bound to tenant,
initiating actor, tool/version, canonical input, and idempotency key. Approval
is revalidated on every retry or resume. An invalid approval stops execution
with a stable approval error.

Idempotency is tenant- and tool-version-scoped. The claim stores a canonical
request hash and the canonical response for a minimum 24-hour deduplication
window. Same-hash duplicates replay the response; different-hash duplicates
return `TOOL_CONFLICT`. All outcomes, including rejected requests, have
redacted audit linkage.

Error codes are stable machine interfaces while messages are safe presentation
text. Validation is deterministic: unknown envelope fields, unsupported
versions, malformed references, and invalid typed input fail before policy or
side effects. Retryable provider, timeout, rate-limit, and transient
infrastructure failures may be retried with bounded backoff and the same
idempotency key. Compensation is explicit, separately registered, and audited.
