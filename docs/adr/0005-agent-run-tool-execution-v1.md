# ADR-0005: Freeze AgentRun and ToolExecution v1

- Status: accepted
- Date: 2026-08-22
- Owners: Architect + Agent Runtime reviewers
- Approved by: project owner
- Related issue: YUC-8

## Context

The MVP needs one auditable lifecycle for agent work and each typed tool
attempt. Approval pauses, provider retries, cancellation, worker restarts, and
model cost accounting must not create duplicate side effects or lose tenant and
trace linkage.

## Decision

- Freeze `AgentRun` and `ToolExecution` at contract version `1.0` with strict
  schemas and explicit terminal/non-terminal states.
- Keep `AgentRun` stable across retries; create a distinct `ToolExecution` and
  audit record for each attempt.
- Pause high-risk work in `waiting_approval`; resume only after current
  TenantContext, policy, approval, and idempotency are revalidated.
- Retry only normalized retryable errors, with bounded persisted backoff and the
  same idempotency key and trace.
- Treat running cancellation as cooperative and recover worker restarts from
  persisted state plus provider/idempotency reconciliation.
- Store structured token, cost, model, latency, and failure fields while keeping
  payloads redacted and referenced out of lifecycle records.

## Alternatives considered

- Creating a new AgentRun for every retry was rejected because it breaks logical
  task metrics, trace continuity, and approval binding.
- Treating a timeout as success was rejected because an external provider may
  have applied the side effect.
- Automatically resuming after restart without reconciliation was rejected
  because it can duplicate an unknown in-flight side effect.
- Embedding prompts and tool payloads was rejected because it expands retention
  and secret/PII exposure.

## Consequences

Executors need an atomic transition store, an idempotency claim, normalized
provider reconciliation, and an audit write for every transition. Operations
can derive MVP metrics without parsing logs, while payload inspection requires
separate redaction-aware storage and access controls.

## Compatibility and migration

Unknown versions, fields, and states fail closed. Additive non-security metadata
requires a negotiated minor version. State, retry, approval, linkage, retention,
or accounting semantic changes require a new major version and ADR. Existing
records remain interpreted using their declared version.
