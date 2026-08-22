# Agent Runtime observability runbook

## Safe telemetry contract

`ProductionAgentRuntimeService` emits structured lifecycle events for AgentRun,
ToolExecution, approval transitions, recovery, and provider effects. Every event
contains `tenant_id`, `trace_id`, and the available `agent_run_id`,
`tool_execution_id`, `approval_id`, and `correlation_id`.

Events and `RuntimeMetrics` never contain prompts, tool input/output, provider
payloads, idempotency keys, credentials, uploaded content, contact details, or
arbitrary caller attributes. Metric dimensions are limited to operation, outcome,
stable error code, and provider reconciliation state; tenant and trace remain
log/audit fields only.

## Staging diagnosis

Use the trusted TenantContext captured by ingress for the original tenant and
trace. Call `PostgresRuntimeStore.QueryOperationalAudit(context, query)`; it
cannot query another tenant or trace and returns only redacted lifecycle fields.
Supply a `correlation_id` to isolate a provider effect. The result covers audit
transitions and provider-effect reconciliation records in newest-first order.

| Scenario | Expected evidence |
| --- | --- |
| Success | `agent_run.create`, `tool_execution.create`, and terminal transition events with `accepted` outcome. |
| Approval rejection | `waiting_approval` transition followed by a rejected resume/transition event and an `APPROVAL_*` error code. |
| Timeout | Tool transition to `waiting_retry`, with stable `TOOL_TIMEOUT` failure metadata; no second logical run. |
| Recovery | `runtime.recover` event; unresolved provider state has `RUNTIME_UNKNOWN_IN_FLIGHT_EFFECT` and is failed closed. |
| Duplicate request | A repeated create is accepted as a replay; altered input has `RUNTIME_CONFLICT` and no additional execution. |

## Alerts

Alert from `RuntimeMetrics` over a five-minute window, linking the on-call
dashboard to the affected tenant-safe trace query rather than embedding raw
payloads:

1. `RUNTIME_CONFLICT` above the baseline: investigate client retry/idempotency misuse.
2. `APPROVAL_*` rejected events above the baseline: inspect expired or mismatched approval binding.
3. `RUNTIME_NOT_FOUND` on tenant-scoped operations above the baseline: investigate possible cross-tenant access attempts without revealing resource existence.
4. `provider_effect.reconcile` with `unknown_in_flight`: page immediately; do not retry until the provider gives an authenticated result.
5. `runtime.recover` rejected events or `RUNTIME_UNKNOWN_IN_FLIGHT_EFFECT`: page immediately; preserve the binding and execute manual audited recovery.

## Sampling and retention

Keep all rejection, recovery, approval, and provider-effect events. Sample only
successful high-volume lifecycle events at the log sink; do not sample audit
references or metrics. Retain audit references and redacted diagnostic fields
for the configured audit retention period. Payload inspection, if enabled in a
separate system, requires tenant-scoped authorization and its own redaction and
deletion policy.
