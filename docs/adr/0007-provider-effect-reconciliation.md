# ADR-0007: Provider Effect Idempotency and Reconciliation

- Status: accepted
- Date: 2026-08-22
- Owners: Agent Runtime reviewers
- Approved by: project owner
- Related issue: YUC-29

## Context

Provider calls can outlive a worker. A timeout, process restart, or lost response
does not establish whether an external side effect happened. Retrying a
non-reentrant request in that state can duplicate a domain purchase, publication,
or other irreversible action.

## Decision

The runtime persists one immutable `ProviderEffectBinding` before dispatching a
provider call. Its `effect_id` is the provider-operation identity and is bound
to contract version, AgentRun, ToolExecution attempt, exact TenantContext
(tenant, actor, actor type, trace), tool/version, idempotency key, canonical
SHA-256 request hash, audit ID, and correlation ID. The provider receives the
same effect identity and idempotency key; raw inputs, credentials, and raw
provider payloads are never stored in this binding.

High-risk effects additionally bind an approval request to the same canonical
request hash. A missing, partial, or mismatched approval binding fails before
dispatch. Recovery refreshes authorization and approval using the current
TenantContext before it can take any action.

`ProductionRuntimeStore` must atomically claim an effect, query/reconcile it,
and record the normalized result. Reconciliation returns exactly one state:

| State | Recovery action |
| --- | --- |
| `safe_to_retry` | Retry only with the same effect identity, idempotency key, and canonical hash. |
| `completed` | Persist the canonical terminal outcome; do not dispatch again. |
| `failed` | Persist the explicit failure; retry only if the provider explicitly reports it safe. |
| `unknown_in_flight` | Fail closed. Do not auto-retry; keep the execution paused for provider inquiry or a manually audited recovery decision. |

Provider queries have a persisted `reconcile_by` deadline. A query timeout,
unavailable provider, missing correlation record, or unrecognized response is
normalized to `unknown_in_flight`, not `safe_to_retry`. Only an explicit,
authenticated provider result can establish completion, failure, or safe retry.
Manual recovery must write a new audit record and preserve the original binding;
it cannot mint a new idempotency key or alter tenant, approval, trace, or hash.

## Alternatives considered

- Retrying every timeout was rejected because timeouts may conceal a completed
  non-reentrant provider action.
- Treating an unknown effect as completed was rejected because it hides failures
  and breaks reliable workflow recovery.
- Allowing provider adapters to decide their own identity fields was rejected
  because it permits cross-tenant, approval, and idempotency drift.

## Consequences

Provider adapters implement the typed `ProductionRuntimeStore` effect methods
and normalize vendor status into the four states. The runtime can resume only
after reconciliation proves a safe action. The interface and contract tests
cover duplicate/canonical-hash conflicts, cross-tenant binding, approval
mismatches, and fail-closed unknown effects.

## Compatibility and migration

This is a persistence-boundary contract for Agent Runtime v1. Existing
in-flight records without a complete binding are `unknown_in_flight` and require
manual recovery. Changes to identity fields, approval binding, state meanings,
or automatic-retry policy require a new major runtime contract, ADR, migration,
and conformance tests.
