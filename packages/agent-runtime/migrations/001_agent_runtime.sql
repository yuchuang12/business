CREATE TABLE agent_runs (
  agent_run_id TEXT PRIMARY KEY,
  contract_version TEXT NOT NULL CHECK (contract_version = '1.0'),
  tenant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  workflow_instance_id TEXT,
  agent_type TEXT NOT NULL CHECK (agent_type IN ('merchant', 'customer', 'system')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_approval', 'waiting_retry', 'cancel_requested', 'completed', 'failed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  approval_request_id TEXT,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  retry JSONB NOT NULL,
  accounting JSONB NOT NULL,
  failure JSONB,
  audit_id TEXT NOT NULL
);

CREATE INDEX agent_runs_tenant_status_idx ON agent_runs (tenant_id, status);
CREATE INDEX agent_runs_trace_idx ON agent_runs (tenant_id, trace_id);

CREATE TABLE tool_executions (
  tool_execution_id TEXT PRIMARY KEY,
  agent_run_id TEXT NOT NULL REFERENCES agent_runs(agent_run_id),
  contract_version TEXT NOT NULL CHECK (contract_version = '1.0'),
  tenant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_approval', 'waiting_retry', 'cancel_requested', 'succeeded', 'failed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  approval_request_id TEXT,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  retry JSONB NOT NULL,
  accounting JSONB NOT NULL,
  failure JSONB,
  audit_id TEXT NOT NULL,
  UNIQUE (tenant_id, tool_name, tool_version, idempotency_key)
);

CREATE INDEX tool_executions_tenant_status_idx ON tool_executions (tenant_id, status);
CREATE INDEX tool_executions_run_idx ON tool_executions (tenant_id, agent_run_id);

CREATE TABLE agent_runtime_audit_refs (
  audit_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE agent_runtime_idempotency (
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  target_id TEXT NOT NULL,
  response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, scope)
);
