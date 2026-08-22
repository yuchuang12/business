CREATE INDEX agent_runtime_audit_refs_tenant_trace_created_idx
  ON agent_runtime_audit_refs (tenant_id, trace_id, created_at DESC);

CREATE INDEX provider_effects_tenant_trace_correlation_created_idx
  ON provider_effects (tenant_id, trace_id, correlation_id, created_at DESC);
