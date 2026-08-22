ALTER TABLE agent_runs ADD COLUMN recovery_claim_until TIMESTAMPTZ;
ALTER TABLE tool_executions ADD COLUMN recovery_claim_until TIMESTAMPTZ;

CREATE TABLE provider_effects (
  effect_id TEXT PRIMARY KEY,
  contract_version TEXT NOT NULL CHECK (contract_version = '1.0'),
  agent_run_id TEXT NOT NULL REFERENCES agent_runs(agent_run_id),
  tool_execution_id TEXT NOT NULL REFERENCES tool_executions(tool_execution_id),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  tenant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  canonical_request_hash TEXT NOT NULL,
  approval_request_id TEXT,
  approval_input_hash TEXT,
  trace_id TEXT NOT NULL,
  audit_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  reconcile_by TIMESTAMPTZ NOT NULL,
  reconciliation_state TEXT,
  provider_reference TEXT,
  observed_at TIMESTAMPTZ,
  retry_after TIMESTAMPTZ,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((approval_request_id IS NULL) = (approval_input_hash IS NULL)),
  CHECK (reconciliation_state IS NULL OR reconciliation_state IN ('safe_to_retry', 'completed', 'failed', 'unknown_in_flight'))
);

CREATE INDEX provider_effects_tenant_reconcile_idx
  ON provider_effects (tenant_id, reconciliation_state, reconcile_by);
