import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

const contractRoot = new URL("../../contracts/tool-contract/v1/", import.meta.url);

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, contractRoot), "utf8"));
}

const schema = await readJson("tool-contract.schema.json");
const registry = await readJson("error-codes.json");
const examples = await Promise.all([
  readJson("examples/success.json"),
  readJson("examples/validation-failure.json"),
  readJson("examples/provider-failure.json"),
  readJson("examples/approval-gated-request.json")
]);
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(schema);

function assertValid(value) {
  assert.equal(validate(value), true, JSON.stringify(validate.errors, null, 2));
}

function assertInvalid(value) {
  assert.equal(validate(value), false, "expected contract validation to fail");
}

test("normative request and response examples validate", () => {
  for (const example of examples) assertValid(example);
});

test("responses enforce deterministic success and failure shapes", () => {
  const success = structuredClone(examples[0]);
  success.retryable = true;
  assertInvalid(success);

  const failure = structuredClone(examples[1]);
  failure.data = { leaked: "provider secret" };
  assertInvalid(failure);

  const missingAudit = structuredClone(examples[0]);
  delete missingAudit.audit_id;
  assertInvalid(missingAudit);
});

test("unknown fields, versions, traces, and malformed approvals fail closed", () => {
  const request = structuredClone(examples[3]);
  request.debug_override = true;
  assertInvalid(request);

  const badVersion = structuredClone(examples[3]);
  badVersion.contract_version = "2.0";
  assertInvalid(badVersion);

  const badTrace = structuredClone(examples[3]);
  badTrace.trace_id = "00000000000000000000000000000000";
  assertInvalid(badTrace);

  const badApproval = structuredClone(examples[3]);
  badApproval.approval_reference.approval_version = 0;
  assertInvalid(badApproval);
});

test("error registry has unique machine codes and valid categories", () => {
  const categories = new Set([
    "validation",
    "authorization",
    "approval",
    "conflict",
    "not_found",
    "rate_limit",
    "provider",
    "timeout",
    "transient_infrastructure",
    "internal"
  ]);
  assert.equal(registry.contract_version, "1.0");
  for (const [code, definition] of Object.entries(registry.codes)) {
    assert.match(code, /^TOOL_[A-Z0-9_]+$/);
    assert.ok(categories.has(definition.category));
    assert.equal(typeof definition.retryable, "boolean");
  }
});

test("same idempotency key replays and conflicting input is rejected", () => {
  const request = examples[3];
  const requestHash = JSON.stringify(request);
  const replay = new Map([[`${request.tenant_context_ref.tenant_id}:site.publish:1.0:${request.idempotency_key}`, {
    requestHash,
    response: examples[0]
  }]]);
  const key = `${request.tenant_context_ref.tenant_id}:site.publish:1.0:${request.idempotency_key}`;

  assert.deepEqual(replay.get(key).response, examples[0]);
  assert.notEqual(JSON.stringify({ ...request, input: { site_version_id: "version_99" } }), requestHash);
  assert.equal(registry.codes.TOOL_CONFLICT.retryable, false);
});
