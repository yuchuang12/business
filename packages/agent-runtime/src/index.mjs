export { AgentRuntimeService } from "./runtime-service.mjs";
export { InMemoryRuntimeStore } from "./in-memory-store.mjs";
export { RuntimeError } from "./errors.mjs";
export { RUN_TRANSITIONS, TOOL_TRANSITIONS, canTransition } from "./transitions.mjs";
import { createHash } from "node:crypto";

const ERROR_CODES = {
  TOOL_INVALID_REQUEST: ["validation", false, "The request is invalid."],
  TOOL_FORBIDDEN: ["authorization", false, "The request is not authorized."],
  TOOL_APPROVAL_REQUIRED: ["approval", false, "Approval is required before this action can run."],
  TOOL_APPROVAL_EXPIRED: ["approval", false, "The approval is no longer valid."],
  TOOL_CONFLICT: ["conflict", false, "The request conflicts with an earlier request."],
  TOOL_NOT_FOUND: ["not_found", false, "The requested product is not available."],
  TOOL_PROVIDER_FAILED: ["provider", true, "The product service is temporarily unavailable."]
};

const clone = (value) => structuredClone(value);
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

function failure(code, traceId, auditId, toolExecutionId, idempotencyKey, details) {
  const [category, retryable, message] = ERROR_CODES[code] ?? ["internal", false, "The request could not be completed."];
  return {
    envelope_type: "tool_response",
    contract_version: "1.0",
    success: false,
    data: null,
    error: { code, category, message, ...(details ? { details } : {}) },
    retryable,
    trace_id: traceId,
    audit_id: auditId,
    tool_execution_id: toolExecutionId,
    idempotency_key: idempotencyKey
  };
}

function success(data, traceId, auditId, toolExecutionId, idempotencyKey) {
  return {
    envelope_type: "tool_response",
    contract_version: "1.0",
    success: true,
    data,
    error: null,
    retryable: false,
    trace_id: traceId,
    audit_id: auditId,
    tool_execution_id: toolExecutionId,
    idempotency_key: idempotencyKey
  };
}

function assertContext(context) {
  if (!context || context.schema_version !== "1.0" || !context.tenant_id ||
      !context.actor_id || !context.trace_id || !context.request_origin ||
      !Array.isArray(context.roles) || !Array.isArray(context.scopes)) {
    throw new Error("TOOL_INVALID_REQUEST");
  }
  return Object.freeze(clone(context));
}

export class AgentRuntimeFixture {
  constructor({ products = [], approve = () => false, productProvider } = {}) {
    this.products = products.map(clone);
    this.approve = approve;
    this.productProvider = productProvider ?? ((product) => product);
    this.runs = new Map();
    this.executions = new Map();
    this.idempotency = new Map();
    this.pendingApprovals = new Map();
    this.sequence = 0;
  }

  next(prefix) {
    this.sequence += 1;
    return `${prefix}_${this.sequence}`;
  }

  startRun(context, agentType = "customer") {
    const trusted = assertContext(context);
    const run = {
      contract_version: "1.0",
      agent_run_id: this.next("run"),
      tenant_id: trusted.tenant_id,
      actor_id: trusted.actor_id,
      trace_id: trusted.trace_id,
      agent_type: agentType,
      status: "running",
      created_at: "2026-08-22T00:00:00Z",
      updated_at: "2026-08-22T00:00:00Z",
      started_at: "2026-08-22T00:00:00Z",
      attempt: 1,
      retry: { retryable: false, retry_count: 0, max_retries: 2 },
      accounting: { input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_minor: 0, currency: "USD", latency_ms: 0 },
      failure: null,
      audit_id: this.next("audit")
    };
    this.runs.set(run.agent_run_id, run);
    return { context: trusted, run };
  }

  executeTool({ context, run, toolName, input, idempotencyKey, highRisk = false, approvalId, attempt = 1 }) {
    const trusted = assertContext(context);
    if (!run || run.tenant_id !== trusted.tenant_id || run.actor_id !== trusted.actor_id ||
        run.trace_id !== trusted.trace_id) throw new Error("TOOL_FORBIDDEN");
    if (!idempotencyKey || idempotencyKey.length < 16 || !input || typeof input !== "object") {
      return this.recordFailure(run, trusted, toolName, idempotencyKey, "TOOL_INVALID_REQUEST");
    }
    const requestHash = createHash("sha256").update(canonical({ context: trusted, toolName, input })).digest("hex");
    const key = `${trusted.tenant_id}:${toolName}:1.0:${idempotencyKey}`;
    const prior = this.idempotency.get(key);
    if (prior && !prior.response.retryable) {
      if (prior.requestHash !== requestHash) return this.recordFailure(run, trusted, toolName, idempotencyKey, "TOOL_CONFLICT");
      return clone(prior.response);
    }
    if (!trusted.scopes.includes("product:read")) {
      return this.recordFailure(run, trusted, toolName, idempotencyKey, "TOOL_FORBIDDEN");
    }
    if (highRisk && !approvalId) {
      run.status = "waiting_approval";
      run.approval_request_id = approvalId ?? this.next("approval");
      this.pendingApprovals.set(run.approval_request_id, {
        tenant_id: trusted.tenant_id,
        actor_id: trusted.actor_id,
        trace_id: trusted.trace_id,
        tool_name: toolName,
        input: clone(input),
        idempotency_key: idempotencyKey
      });
      const executionId = this.next("exec");
      const auditId = this.next("audit");
      this.executions.set(executionId, {
        contract_version: "1.0", tool_execution_id: executionId, agent_run_id: run.agent_run_id,
        tenant_id: trusted.tenant_id, actor_id: trusted.actor_id, trace_id: trusted.trace_id,
        tool_name: toolName, tool_version: "1.0", idempotency_key: idempotencyKey,
        status: "waiting_approval", attempt, retry: { retryable: false, retry_count: 0, max_retries: 2 },
        accounting: { input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_minor: 0, currency: "USD", latency_ms: 0 },
        approval_request_id: run.approval_request_id, audit_id: auditId,
        created_at: "2026-08-22T00:00:00Z", updated_at: "2026-08-22T00:00:00Z"
      });
      return failure("TOOL_APPROVAL_REQUIRED", trusted.trace_id, auditId, executionId, idempotencyKey);
    }
    if (highRisk) {
      const pending = this.pendingApprovals.get(approvalId);
      if (!pending && this.approve({ approvalId, context: trusted, input, idempotencyKey })) {
        return this.perform({ trusted, run, toolName, input, idempotencyKey, requestHash, attempt, key });
      }
      const matches = pending &&
        pending.tenant_id === trusted.tenant_id &&
        pending.actor_id === trusted.actor_id &&
        pending.trace_id === trusted.trace_id &&
        pending.tool_name === toolName &&
        pending.idempotency_key === idempotencyKey &&
        canonical(pending.input) === canonical(input);
      if (!matches || !this.approve({ approvalId, context: trusted, input, idempotencyKey })) {
        return this.recordFailure(run, trusted, toolName, idempotencyKey, "TOOL_APPROVAL_EXPIRED");
      }
      this.pendingApprovals.delete(approvalId);
    }
    return this.perform({ trusted, run, toolName, input, idempotencyKey, requestHash, attempt, key });
  }

  perform({ trusted, run, toolName, input, idempotencyKey, requestHash, attempt, key }) {
    const execution = {
      contract_version: "1.0",
      tool_execution_id: this.next("exec"),
      agent_run_id: run.agent_run_id,
      tenant_id: trusted.tenant_id,
      actor_id: trusted.actor_id,
      trace_id: trusted.trace_id,
      tool_name: toolName,
      tool_version: "1.0",
      idempotency_key: idempotencyKey,
      status: "running",
      attempt,
      retry: { retryable: false, retry_count: attempt - 1, max_retries: 2 },
      accounting: { input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_minor: 0, currency: "USD", latency_ms: 0 },
      audit_id: this.next("audit"),
      created_at: "2026-08-22T00:00:00Z", updated_at: "2026-08-22T00:00:00Z"
    };
    this.executions.set(execution.tool_execution_id, execution);
    let response;
    try {
      if (toolName !== "product.lookup") throw new Error("TOOL_INVALID_REQUEST");
      if (input.tenant_id !== undefined || typeof input.product_id !== "string" || input.product_id.length === 0) {
        throw new Error("TOOL_INVALID_REQUEST");
      }
      const product = this.products.find((candidate) =>
        candidate.tenant_id === trusted.tenant_id && candidate.product_id === input.product_id);
      if (!product) throw new Error("TOOL_NOT_FOUND");
      const canonicalProduct = clone(this.productProvider(product));
      if (!canonicalProduct || canonicalProduct.tenant_id !== trusted.tenant_id ||
          canonicalProduct.product_id !== product.product_id) throw new Error("TOOL_PROVIDER_FAILED");
      execution.status = "succeeded";
      response = success({ product: canonicalProduct }, trusted.trace_id, execution.audit_id,
        execution.tool_execution_id, idempotencyKey);
    } catch (error) {
      const code = ERROR_CODES[error.message] ? error.message : "TOOL_PROVIDER_FAILED";
      execution.status = code === "TOOL_PROVIDER_FAILED" ? "waiting_retry" : "failed";
      execution.retry.retryable = ERROR_CODES[code][1];
      execution.retry.last_error_code = code;
      run.status = execution.status === "waiting_retry" ? "waiting_retry" : "failed";
      response = failure(code, trusted.trace_id, execution.audit_id, execution.tool_execution_id, idempotencyKey);
    }
    if (response.success || !response.retryable) {
      this.idempotency.set(key, { requestHash, response: clone(response) });
    }
    if (response.success) run.status = "completed";
    return response;
  }

  recordFailure(run, context, toolName, idempotencyKey, code) {
    const auditId = this.next("audit");
    return failure(code, context.trace_id, auditId, undefined, idempotencyKey);
  }

  lookupProduct({ context, productId, idempotencyKey }) {
    const { context: trusted, run } = this.startRun(context);
    const response = this.executeTool({
      context: trusted, run, toolName: "product.lookup",
      input: { product_id: productId }, idempotencyKey
    });
    return { run: clone(run), response };
  }

  resumeRetry({ context, runId, productId, idempotencyKey }) {
    const run = this.runs.get(runId);
    if (!run || run.status !== "waiting_retry") return this.lookupProduct({ context, productId, idempotencyKey });
    run.status = "running";
    return { run: clone(run), response: this.executeTool({
      context, run, toolName: "product.lookup", input: { product_id: productId },
      idempotencyKey, attempt: 2
    }) };
  }
}
