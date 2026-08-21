export class InMemoryRuntimeStore {
  constructor() {
    this.agentRuns = new Map();
    this.toolExecutions = new Map();
    this.idempotency = new Map();
    this.audit = [];
  }

  putRun(run) { this.agentRuns.set(run.agent_run_id, structuredClone(run)); }
  getRun(id) { return this.agentRuns.get(id); }
  putTool(execution) { this.toolExecutions.set(execution.tool_execution_id, structuredClone(execution)); }
  getTool(id) { return this.toolExecutions.get(id); }
  findToolByIdempotency(scope) {
    const id = this.idempotency.get(scope);
    return id ? this.getTool(id) : undefined;
  }
  claimIdempotency(scope, toolExecutionId) {
    const existing = this.idempotency.get(scope);
    if (existing) return existing;
    this.idempotency.set(scope, toolExecutionId);
    return toolExecutionId;
  }
  recordAudit(entry) { this.audit.push(structuredClone(entry)); }
  listNonTerminal(tenantId) {
    const terminal = new Set(["completed", "failed", "cancelled", "succeeded"]);
    return [
      ...this.agentRuns.values(),
      ...this.toolExecutions.values()
    ].filter((record) => record.tenant_id === tenantId && !terminal.has(record.status));
  }
}
