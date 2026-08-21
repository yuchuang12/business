# Agent Runtime Golden Path Fixture

The fixture in `packages/agent-runtime` is the deterministic runtime boundary
used by YUC-18. `lookupProduct` accepts a trusted `TenantContext`, creates one
customer `AgentRun`, and invokes the typed `product.lookup` tool. Product
resolution always filters by the trusted `tenant_id`; a foreign product is
returned as `TOOL_NOT_FOUND`.

Tool responses preserve `trace_id`, `agent_run_id`, `tool_execution_id`,
`audit_id`, and the idempotency key. Retryable provider failures leave the run
in `waiting_retry`; `resumeRetry` reuses the logical run and key while creating
a new execution attempt. High-risk calls enter `waiting_approval` without
calling the provider and resume only after the approval callback accepts the
bound request.

Run the focused fixture test from the repository root:

```sh
node --test tests/e2e/agent-runtime-golden-path.test.mjs
```
