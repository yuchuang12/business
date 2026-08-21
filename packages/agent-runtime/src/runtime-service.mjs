import { fail } from "./errors.mjs";
import { InMemoryRuntimeStore } from "./in-memory-store.mjs";
import { RUN_TRANSITIONS, TOOL_TRANSITIONS, canTransition } from "./transitions.mjs";

const TERMINAL = new Set(["completed", "failed", "cancelled", "succeeded"]);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const TRACE = /^[0-9a-f]{32}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;

function now() { return new Date().toISOString().replace(/\d{3}Z$/, "Z"); }
function id(prefix) { return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`; }

function requireContext(context) {
  if (!context || context.schema_version !== "1.0" ||
      typeof context.tenant_id !== "string" || !ID.test(context.tenant_id) ||
      typeof context.actor_id !== "string" || !ID.test(context.actor_id) ||
      typeof context.trace_id !== "string" || !TRACE.test(context.trace_id) ||
      !Array.isArray(context.roles) || !Array.isArray(context.scopes) ||
      !context.request_origin || typeof context.request_origin.request_id !== "string") {
    fail("TENANT_CONTEXT_INVALID", "A valid TenantContext v1 is required.");
  }
  return structuredClone(context);
}

function accounting() {
  return { model: null, input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_minor: 0, currency: "USD", latency_ms: 0 };
}
function retry(maxRetries = 3) {
  return { retryable: false, retry_count: 0, max_retries: maxRetries, next_retry_at: null, backoff_ms: null, last_error_code: null };
}

export class AgentRuntimeService {
  constructor({ store = new InMemoryRuntimeStore(), approvalValidator = () => true, authorizationValidator = () => true } = {}) {
    this.store = store;
    this.approvalValidator = approvalValidator;
    this.authorizationValidator = authorizationValidator;
  }

  audit(context, action, record, outcome, details = {}) {
    this.store.recordAudit({
      audit_id: id("audit"), contract_version: "1.0", tenant_id: context.tenant_id,
      actor_id: context.actor_id, trace_id: context.trace_id, action,
      target_type: record?.agent_run_id ? "agent_run" : "tool_execution",
      target_id: record?.agent_run_id ?? record?.tool_execution_id ?? null, outcome, details
    });
  }

  assertOwned(context, record, kind) {
    requireContext(context);
    if (!record || record.tenant_id !== context.tenant_id ||
        record.actor_id !== context.actor_id || record.trace_id !== context.trace_id) {
      fail("RUNTIME_NOT_FOUND", `${kind} is not visible in this tenant.`);
    }
    return record;
  }

  createRun(context, { agentType = "merchant", workflowInstanceId, maxRetries = 3, idempotencyKey } = {}) {
    context = requireContext(context);
    if (!["merchant", "customer", "system"].includes(agentType)) fail("RUNTIME_VALIDATION", "Invalid agent type.");
    const scope = idempotencyKey && `${context.tenant_id}:agent-run:${idempotencyKey}`;
    if (scope) {
      const existing = this.store.idempotency.get(scope);
      if (existing) return { record: structuredClone(this.store.getRun(existing)), duplicate: true };
    }
    const timestamp = now();
    const run = {
      contract_version: "1.0", agent_run_id: id("run"), tenant_id: context.tenant_id,
      actor_id: context.actor_id, trace_id: context.trace_id, workflow_instance_id: workflowInstanceId,
      agent_type: agentType, status: "queued", created_at: timestamp, updated_at: timestamp,
      started_at: null, ended_at: null, attempt: 1, retry: retry(maxRetries),
      accounting: accounting(), failure: null, audit_id: id("audit")
    };
    this.store.putRun(run);
    if (scope) this.store.idempotency.set(scope, run.agent_run_id);
    this.audit(context, "run.create", run, "accepted", { duplicate: false });
    return { record: structuredClone(run), duplicate: false };
  }

  createToolExecution(context, { agentRunId, toolName, toolVersion = "1.0", idempotencyKey, maxRetries = 3 } = {}) {
    context = requireContext(context);
    if (typeof toolName !== "string" || !ID.test(toolName) || typeof idempotencyKey !== "string" || idempotencyKey.length < 16) {
      fail("RUNTIME_VALIDATION", "Tool name and idempotency key are required.");
    }
    const run = this.assertOwned(context, this.store.getRun(agentRunId), "AgentRun");
    if (TERMINAL.has(run.status)) fail("RUNTIME_CONFLICT", "Cannot add work to a terminal AgentRun.");
    const scope = `${context.tenant_id}:${toolName}:${toolVersion}:${idempotencyKey}`;
    const existingId = this.store.idempotency.get(scope);
    if (existingId) return { record: structuredClone(this.store.getTool(existingId)), duplicate: true };
    const timestamp = now();
    const execution = {
      contract_version: "1.0", tool_execution_id: id("exec"), agent_run_id: run.agent_run_id,
      workflow_instance_id: run.workflow_instance_id, tenant_id: context.tenant_id,
      actor_id: context.actor_id, trace_id: context.trace_id, tool_name: toolName,
      tool_version: toolVersion, idempotency_key: idempotencyKey, status: "queued",
      created_at: timestamp, updated_at: timestamp, started_at: null, ended_at: null,
      attempt: 1, retry: retry(maxRetries), accounting: accounting(), failure: null, audit_id: id("audit")
    };
    this.store.putTool(execution);
    this.store.claimIdempotency(scope, execution.tool_execution_id);
    this.audit(context, "tool.create", execution, "accepted", { duplicate: false });
    return { record: structuredClone(execution), duplicate: false };
  }

  transitionRun(context, runId, to, details = {}) {
    return this.#transition(context, this.store.getRun(runId), to, RUN_TRANSITIONS, "AgentRun", details);
  }
  transitionTool(context, executionId, to, details = {}) {
    return this.#transition(context, this.store.getTool(executionId), to, TOOL_TRANSITIONS, "ToolExecution", details);
  }

  #transition(context, record, to, table, kind, details) {
    this.assertOwned(context, record, kind);
    if (!canTransition(table, record.status, to)) {
      this.audit(context, "lifecycle.transition", record, "rejected", { code: "LIFECYCLE_ILLEGAL_TRANSITION", from: record.status, to });
      fail("LIFECYCLE_ILLEGAL_TRANSITION", `Cannot transition ${kind} from ${record.status} to ${to}.`);
    }
    if (to === "waiting_approval" && !details.approvalRequestId) {
      fail("APPROVAL_REQUIRED", "Approval reference is required.");
    }
    const timestamp = now();
    record.status = to;
    record.updated_at = timestamp;
    if (to === "running" && !record.started_at) record.started_at = timestamp;
    if (TERMINAL.has(to)) record.ended_at = timestamp;
    if (details.approvalRequestId) record.approval_request_id = details.approvalRequestId;
    this.store[record.agent_run_id ? "putRun" : "putTool"](record);
    this.audit(context, "lifecycle.transition", record, "accepted", { to });
    return structuredClone(record);
  }

  pauseForApproval(context, idValue, approvalRequestId, kind = "tool") {
    if (typeof approvalRequestId !== "string" || !ID.test(approvalRequestId)) fail("APPROVAL_REQUIRED", "Approval reference is required.");
    return kind === "run"
      ? this.transitionRun(context, idValue, "waiting_approval", { approvalRequestId })
      : this.transitionTool(context, idValue, "waiting_approval", { approvalRequestId });
  }

  waitForRetry(context, idValue, { errorCode = "RUNTIME_RETRYABLE", backoffMs = 0, kind = "tool" } = {}) {
    const record = kind === "run" ? this.transitionRun(context, idValue, "waiting_retry") : this.transitionTool(context, idValue, "waiting_retry");
    record.retry.retryable = true;
    record.retry.backoff_ms = backoffMs;
    record.retry.last_error_code = errorCode;
    record.retry.next_retry_at = null;
    record.failure = {
      category: "transient_infrastructure",
      code: errorCode,
      retryable: true,
      message: "Execution can be retried."
    };
    if (kind === "run") this.store.putRun(record);
    else this.store.putTool(record);
    return structuredClone(record);
  }

  resume(context, idValue, kind = "tool") {
    context = requireContext(context);
    const record = this.assertOwned(context, kind === "run" ? this.store.getRun(idValue) : this.store.getTool(idValue), kind === "run" ? "AgentRun" : "ToolExecution");
    if (record.status === "waiting_approval" &&
        (!record.approval_request_id || !this.approvalValidator(record.approval_request_id, context, record))) {
      fail("APPROVAL_INVALID", "Approval reference is missing or invalid.");
    }
    if (!this.authorizationValidator(context, record)) fail("TENANT_AUTHORIZATION_REVOKED", "Current authorization does not permit resume.");
    return kind === "run" ? this.transitionRun(context, idValue, "running") : this.transitionTool(context, idValue, "running");
  }

  retry(context, executionId) {
    context = requireContext(context);
    const current = this.assertOwned(context, this.store.getTool(executionId), "ToolExecution");
    if (current.status !== "waiting_retry" || !current.retry.retryable || current.retry.retry_count >= current.retry.max_retries) {
      fail("RETRY_NOT_ALLOWED", "ToolExecution is not eligible for retry.");
    }
    const next = structuredClone(current);
    next.tool_execution_id = id("exec");
    next.audit_id = id("audit");
    next.status = "running";
    next.attempt += 1;
    next.retry.retry_count += 1;
    next.retry.next_retry_at = null;
    next.updated_at = now();
    next.started_at = next.updated_at;
    this.store.putTool(next);
    this.audit(context, "tool.retry", next, "accepted", { previous_execution_id: current.tool_execution_id });
    return structuredClone(next);
  }

  cancel(context, idValue, kind = "tool") {
    const record = kind === "run" ? this.store.getRun(idValue) : this.store.getTool(idValue);
    this.assertOwned(context, record, kind === "run" ? "AgentRun" : "ToolExecution");
    if (record.status === "running") return kind === "run" ? this.transitionRun(context, idValue, "cancel_requested") : this.transitionTool(context, idValue, "cancel_requested");
    return kind === "run" ? this.transitionRun(context, idValue, "cancelled") : this.transitionTool(context, idValue, "cancelled");
  }

  confirmCancellation(context, idValue, kind = "tool") {
    return kind === "run" ? this.transitionRun(context, idValue, "cancelled") : this.transitionTool(context, idValue, "cancelled");
  }

  recover(context) {
    context = requireContext(context);
    const recovered = [];
    for (const record of this.store.listNonTerminal(context.tenant_id)) {
      if (record.actor_id !== context.actor_id || record.trace_id !== context.trace_id || record.status !== "running") continue;
      const table = record.agent_run_id ? RUN_TRANSITIONS : TOOL_TRANSITIONS;
      if (record.retry.retryable && record.retry.retry_count < record.retry.max_retries) {
        record.status = "waiting_retry";
        record.retry.last_error_code = "RUNTIME_WORKER_RESTART";
        record.retry.next_retry_at = null;
      } else {
        record.status = "failed";
        record.failure = { category: "transient_infrastructure", code: "RUNTIME_WORKER_RESTART", retryable: false, message: "Execution stopped during worker recovery." };
        record.ended_at = now();
      }
      record.updated_at = now();
      this.store[record.agent_run_id ? "putRun" : "putTool"](record);
      this.audit(context, "runtime.recover", record, "accepted", { transition_table: table === RUN_TRANSITIONS ? "run" : "tool" });
      recovered.push(structuredClone(record));
    }
    return recovered;
  }
}
