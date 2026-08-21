import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntimeService, InMemoryRuntimeStore, RuntimeError } from "../src/index.mjs";

const context = (tenant = "tenant_a", actor = "actor_a") => ({
  schema_version: "1.0", tenant_id: tenant, actor_id: actor, actor_type: "user",
  roles: ["tenant_owner"], scopes: ["agent:run", "site:publish"],
  trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
  request_origin: { kind: "merchant_console", request_id: "request_100" }
});

function expectCode(fn, code) {
  assert.throws(fn, (error) => error instanceof RuntimeError && error.code === code);
}

test("creates tenant and trace-linked run/tool records and deduplicates requests", () => {
  const service = new AgentRuntimeService();
  const run = service.createRun(context(), { idempotencyKey: "run-request-0000001" });
  const duplicateRun = service.createRun(context(), { idempotencyKey: "run-request-0000001" });
  assert.equal(duplicateRun.duplicate, true);
  const execution = service.createToolExecution(context(), {
    agentRunId: run.record.agent_run_id, toolName: "site.publish", idempotencyKey: "tool-request-000001"
  });
  const duplicate = service.createToolExecution(context(), {
    agentRunId: run.record.agent_run_id, toolName: "site.publish", idempotencyKey: "tool-request-000001"
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(execution.record.tenant_id, "tenant_a");
  assert.equal(execution.record.trace_id, run.record.trace_id);
  assert.equal(service.store.audit.length, 2);
});

test("rejects missing and cross-tenant context without revealing records", () => {
  const service = new AgentRuntimeService();
  const run = service.createRun(context()).record;
  expectCode(() => service.transitionRun({ tenant_id: "tenant_a" }, run.agent_run_id, "running"), "TENANT_CONTEXT_INVALID");
  expectCode(() => service.transitionRun(context("tenant_b", "actor_b"), run.agent_run_id, "running"), "RUNTIME_NOT_FOUND");
});

test("enforces legal transitions, approval references, and terminal protection", () => {
  const service = new AgentRuntimeService();
  const run = service.createRun(context()).record;
  expectCode(() => service.transitionRun(context(), run.agent_run_id, "completed"), "LIFECYCLE_ILLEGAL_TRANSITION");
  const running = service.transitionRun(context(), run.agent_run_id, "running");
  assert.equal(running.status, "running");
  expectCode(() => service.pauseForApproval(context(), run.agent_run_id, "", "run"), "APPROVAL_REQUIRED");
  service.pauseForApproval(context(), run.agent_run_id, "approval_100", "run");
  const resumed = new AgentRuntimeService({ store: service.store, approvalValidator: (ref) => ref === "approval_100" }).resume(context(), run.agent_run_id, "run");
  assert.equal(resumed.status, "running");
  service.transitionRun(context(), run.agent_run_id, "completed");
  expectCode(() => service.transitionRun(context(), run.agent_run_id, "running"), "LIFECYCLE_ILLEGAL_TRANSITION");
});

test("retry preserves tenant, trace, parent, and idempotency while changing attempt identity", () => {
  const service = new AgentRuntimeService({ store: new InMemoryRuntimeStore() });
  const run = service.createRun(context()).record;
  const execution = service.createToolExecution(context(), {
    agentRunId: run.agent_run_id, toolName: "site.publish", idempotencyKey: "retry-request-00001"
  }).record;
  service.transitionTool(context(), execution.tool_execution_id, "running");
  const waiting = service.waitForRetry(context(), execution.tool_execution_id, { errorCode: "TOOL_TIMEOUT" });
  waiting.retry.max_retries = 2;
  service.store.putTool(waiting);
  const retried = service.retry(context(), waiting.tool_execution_id);
  assert.notEqual(retried.tool_execution_id, waiting.tool_execution_id);
  assert.equal(retried.agent_run_id, run.agent_run_id);
  assert.equal(retried.tenant_id, context().tenant_id);
  assert.equal(retried.trace_id, context().trace_id);
  assert.equal(retried.idempotency_key, waiting.idempotency_key);
  assert.equal(retried.attempt, 2);
});

test("cancellation is cooperative and recovery never assumes running work succeeded", () => {
  const service = new AgentRuntimeService();
  const run = service.createRun(context()).record;
  service.transitionRun(context(), run.agent_run_id, "running");
  assert.equal(service.cancel(context(), run.agent_run_id, "run").status, "cancel_requested");
  assert.equal(service.confirmCancellation(context(), run.agent_run_id, "run").status, "cancelled");
  const recoverable = service.createRun(context(), { maxRetries: 1 }).record;
  service.transitionRun(context(), recoverable.agent_run_id, "running");
  const recovered = service.recover(context());
  assert.equal(recovered.find((item) => item.agent_run_id === recoverable.agent_run_id).status, "failed");
});
