# AgentRun v1

- Contract version: `1.0`
- Schema: `agent-run.schema.json`
- Status: frozen
- Related issue: YUC-8
- Decision record: `docs/adr/0005-agent-run-tool-execution-v1.md`

`AgentRun` is the tenant-scoped logical attempt to complete one agent task. Its
`agent_run_id` is stable across worker restarts and retry attempts. Messages and
planner/executor steps are immutable records referenced by ID; payloads are stored
redacted and are not embedded in this lifecycle contract.

Non-terminal states are `queued`, `running`, `waiting_approval`, `waiting_retry`,
and `cancel_requested`. `completed`, `failed`, and `cancelled` are terminal.
Approval pauses are explicit and require the referenced `ApprovalRequest` to be
revalidated before resuming. A resume keeps the same tenant, actor, trace, and
logical run ID.

Token counts, integer minor-unit cost, model, and latency are structured fields.
Failures contain only a stable category/code and safe message. Raw prompts,
provider payloads, credentials, uploaded content, and tool payloads belong in
redacted stores subject to retention policy.
