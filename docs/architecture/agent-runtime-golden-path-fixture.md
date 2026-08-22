# Agent Runtime Golden Path Fixture

The Go fixture in `packages/agent-runtime` is the deterministic runtime boundary
used by YUC-18 and YUC-23. `LookupProduct` accepts a trusted `TenantContext`, creates one
customer `AgentRun`, and invokes the typed `product.lookup` tool. Product
resolution always filters by the trusted `tenant_id`; a foreign product is
returned as `TOOL_NOT_FOUND`.

Tool responses preserve `trace_id`, `agent_run_id`, `tool_execution_id`,
`audit_id`, and the idempotency key. Retryable provider failures leave the run
in `waiting_retry`; `ResumeRetry` reuses the logical run and key while creating
a new execution attempt. High-risk calls enter `waiting_approval` without
calling the provider and resume only after the approval callback accepts the
bound request.

The former JavaScript fixture maps to Go as follows:

| JavaScript baseline | Go implementation |
| --- | --- |
| `AgentRuntimeFixture` | `agentruntime.AgentRuntimeFixture` |
| `lookupProduct` / `resumeRetry` | `LookupProduct` / `ResumeRetry` |
| `runtime-service.mjs` | `service.go`, `runtime.go` |
| `in-memory-store.mjs` / `transitions.mjs` | `InMemoryRuntimeStore` and explicit transition tables |

Run the focused fixture test from the repository root:

```sh
go test ./tests/e2e
```
