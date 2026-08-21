import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

const root = new URL("../../contracts/", import.meta.url);
async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, root), "utf8"));
}

const [agentSchema, toolSchema, pausedRun, retryingTool] = await Promise.all([
  readJson("agent-run/v1/agent-run.schema.json"),
  readJson("tool-execution/v1/tool-execution.schema.json"),
  readJson("agent-run/v1/examples/approval-paused.json"),
  readJson("tool-execution/v1/examples/retryable-failure.json")
]);
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateRun = ajv.compile(agentSchema);
const validateTool = ajv.compile(toolSchema);

const runTransitions = {
  queued: new Set(["running", "cancelled"]),
  running: new Set(["waiting_approval", "waiting_retry", "cancel_requested", "completed", "failed"]),
  waiting_approval: new Set(["running", "cancelled"]),
  waiting_retry: new Set(["running", "cancelled", "failed"]),
  cancel_requested: new Set(["cancelled"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set()
};
const toolTransitions = {
  queued: new Set(["running", "cancelled"]),
  running: new Set(["waiting_approval", "waiting_retry", "cancel_requested", "succeeded", "failed"]),
  waiting_approval: new Set(["running", "cancelled"]),
  waiting_retry: new Set(["running", "cancelled", "failed"]),
  cancel_requested: new Set(["cancelled"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set()
};

function transition(table, from, to) {
  if (!table[from]?.has(to)) throw new Error("LIFECYCLE_ILLEGAL_TRANSITION");
  return to;
}

test("normative AgentRun and ToolExecution examples validate", () => {
  assert.equal(validateRun(pausedRun), true, JSON.stringify(validateRun.errors));
  assert.equal(validateTool(retryingTool), true, JSON.stringify(validateTool.errors));
});

test("approval pauses are explicit and terminal states require end timestamps", () => {
  assert.equal(pausedRun.status, "waiting_approval");
  assert.equal(pausedRun.approval_request_id, "approval_100");
  const invalid = structuredClone(pausedRun);
  delete invalid.approval_request_id;
  assert.equal(validateRun(invalid), false);
  const terminal = structuredClone(pausedRun);
  terminal.status = "completed";
  terminal.ended_at = "2026-08-21T10:00:04Z";
  delete terminal.approval_request_id;
  assert.equal(validateRun(terminal), true);
});

test("illegal transitions fail deterministically and terminal states do not move", () => {
  assert.equal(transition(runTransitions, "waiting_approval", "running"), "running");
  assert.throws(() => transition(runTransitions, "completed", "running"), /LIFECYCLE_ILLEGAL_TRANSITION/);
  assert.throws(() => transition(toolTransitions, "running", "queued"), /LIFECYCLE_ILLEGAL_TRANSITION/);
});

test("retry preserves logical identity and idempotency while incrementing attempts", () => {
  const resumed = structuredClone(retryingTool);
  resumed.status = transition(toolTransitions, resumed.status, "running");
  resumed.attempt += 1;
  resumed.retry.retry_count += 1;
  resumed.audit_id = "audit_exec_100_2";
  resumed.tool_execution_id = "exec_100_2";
  assert.equal(resumed.agent_run_id, retryingTool.agent_run_id);
  assert.equal(resumed.trace_id, retryingTool.trace_id);
  assert.equal(resumed.idempotency_key, retryingTool.idempotency_key);
  assert.equal(validateTool(resumed), true, JSON.stringify(validateTool.errors));
});

test("tenant, actor, trace, and parent linkage cannot drift on resume", () => {
  const resumed = structuredClone(retryingTool);
  const identityFields = ["tenant_id", "actor_id", "trace_id", "agent_run_id", "idempotency_key"];
  const sameLogicalExecution = (before, after) =>
    identityFields.every((field) => before[field] === after[field]);
  assert.equal(sameLogicalExecution(retryingTool, resumed), true);
  resumed.trace_id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  assert.equal(sameLogicalExecution(retryingTool, resumed), false);
});

test("unknown fields, states, and invalid accounting fail closed", () => {
  const unknown = structuredClone(retryingTool);
  unknown.debug_override = true;
  assert.equal(validateTool(unknown), false);
  const badState = structuredClone(retryingTool);
  badState.status = "paused";
  assert.equal(validateTool(badState), false);
  const badAccounting = structuredClone(retryingTool);
  badAccounting.accounting.total_tokens = -1;
  assert.equal(validateTool(badAccounting), false);
});

test("cancellation and restart recovery remain explicit", () => {
  assert.equal(transition(toolTransitions, "running", "cancel_requested"), "cancel_requested");
  assert.equal(transition(toolTransitions, "cancel_requested", "cancelled"), "cancelled");
  assert.throws(() => transition(toolTransitions, "cancel_requested", "succeeded"), /LIFECYCLE_ILLEGAL_TRANSITION/);
  const recovered = structuredClone(retryingTool);
  recovered.status = transition(toolTransitions, recovered.status, "running");
  assert.equal(recovered.status, "running");
  assert.equal(validateTool(recovered), true);
  assert.notEqual(recovered.status, "succeeded");
});
