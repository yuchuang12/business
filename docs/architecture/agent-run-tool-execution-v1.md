# AgentRun and ToolExecution v1

- Status: accepted
- Contracts: `contracts/agent-run/v1/agent-run.schema.json`,
  `contracts/tool-execution/v1/tool-execution.schema.json`
- Related issue: YUC-8
- Decision record: `docs/adr/0005-agent-run-tool-execution-v1.md`

## State machines

```text
AgentRun:
QUEUED -> RUNNING
RUNNING -> WAITING_APPROVAL -> RUNNING
RUNNING -> WAITING_RETRY -> RUNNING
RUNNING -> CANCEL_REQUESTED -> CANCELLED
QUEUED -> CANCELLED
WAITING_APPROVAL -> CANCELLED
WAITING_RETRY -> CANCELLED
RUNNING -> COMPLETED | FAILED
WAITING_RETRY -> FAILED                 (retry budget exhausted)
```

```text
ToolExecution:
QUEUED -> RUNNING
RUNNING -> WAITING_APPROVAL -> RUNNING
RUNNING -> WAITING_RETRY -> RUNNING
RUNNING -> CANCEL_REQUESTED -> CANCELLED
QUEUED | WAITING_APPROVAL | WAITING_RETRY -> CANCELLED
RUNNING -> SUCCEEDED | FAILED
WAITING_RETRY -> FAILED                  (retry budget exhausted)
```

`completed`, `succeeded`, `failed`, and `cancelled` are terminal. No terminal
state has an outgoing transition. Transitions are persisted atomically and an
illegal transition returns a deterministic lifecycle error without changing the
record.

## Relationships and tracing

One `AgentRun` is the logical parent of zero or more immutable messages/steps and
one or more `ToolExecution` attempts. Every execution has exactly one
`agent_run_id`, the same `tenant_id`, `actor_id`, and `trace_id`, and a distinct
`audit_id`. A workflow instance may own a run and is never a substitute for the
run's tenant boundary. `ApprovalRequest` is referenced by ID and must be bound to
the tenant, actor, tool, canonical input, and idempotency key. `AuditLog` records
every accepted or rejected transition, including pause, resume, retry, cancel, and
recovery.

## Retry, timeout, cancellation, and recovery

Only the ToolContract error registry and executor policy decide retryability.
Retries use the same idempotency key and trace, increment `attempt` and
`retry_count`, and use bounded persisted backoff metadata. Each attempt gets new
execution/audit IDs. Approval is revalidated on every retry and resume.

Timeouts become `waiting_retry` only when the normalized error is retryable and
budget remains; otherwise they become `failed`. Cancellation is cooperative:
queued/paused work can stop immediately, while running work must first enter
`cancel_requested` and confirm side-effect quiescence. After worker restart,
the persisted state is reloaded, context authorization is refreshed, and an
unknown in-flight side effect is never assumed successful. Idempotency replay
or provider reconciliation decides whether it can be resumed safely.

## Observability and retention

Structured accounting includes model, input/output/total tokens, integer
minor-unit cost, currency, and latency. Metrics are derived from these fields:
run/tool counts by outcome, retry count, approval wait duration, latency,
token totals, and cost. Payload references point to redacted stores. Raw prompts,
tool inputs/outputs, provider payloads, credentials, uploaded documents, and
personal contact data are not retained in lifecycle records; retention and
deletion policies apply to referenced stores. Trace IDs and tenant-safe record
IDs remain in audit/metrics for the configured audit retention period.

## Invariants

1. Every `ToolExecution` belongs to one `AgentRun`; tenant and trace linkage
   must match.
2. Approval pause/resume has no side effect while paused and resumes with the
   same logical IDs, context, trace, and idempotency key.
3. Only declared transitions are accepted; terminal states are immutable.
4. A retry never changes the idempotency key or creates a second logical run.
5. Audit linkage exists for every outcome, including validation, cancellation,
   recovery, and illegal-transition rejection.
