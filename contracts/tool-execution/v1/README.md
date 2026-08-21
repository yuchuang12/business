# ToolExecution v1

- Contract version: `1.0`
- Schema: `tool-execution.schema.json`
- Status: frozen
- Related issue: YUC-8
- Decision record: `docs/adr/0005-agent-run-tool-execution-v1.md`

Every `ToolExecution` belongs to exactly one `AgentRun` and carries the trusted
tenant, initiating actor, trace, idempotency, and audit identifiers. Attempts
are counted from one; a retry increments `attempt` and `retry.retry_count` but
retains the same idempotency key and trace. Each attempt has a distinct execution
and audit ID.

`waiting_approval` and `waiting_retry` have no side effects while paused.
Resuming revalidates current TenantContext, tool policy, approval, and the
idempotency claim. A worker restart resumes only from a persisted non-terminal
record; it never converts an unknown in-flight side effect into success.

Success, failure, and cancellation are terminal. Cancellation is cooperative:
queued or paused work can be cancelled immediately; running work first enters
`cancel_requested` and becomes `cancelled` only after the executor confirms that
no further side effect can occur. Cancellation and recovery are audited.
