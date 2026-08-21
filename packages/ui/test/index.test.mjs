import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { validateGenerativeUiRequest } from "../src/index.mjs";

const root = new URL("../../../contracts/generative-ui/v1/", import.meta.url);
const goldenPath = new URL("examples/golden-path.json", root);
const golden = JSON.parse(await readFile(goldenPath, "utf8"));

test("accepts the frozen golden path and rejects hostile payloads", () => {
  assert.equal(validateGenerativeUiRequest(golden).valid, true);
  for (const hostile of [
    { ...golden, contract_version: "2.0" },
    { ...golden, fallback: { kind: "message", text: "<script>alert(1)</script>" } },
    { ...golden, trace_id: "00000000000000000000000000000000" },
    { ...golden, components: [{ ...golden.components[0], type: "arbitrary_html" }] },
    { ...golden, components: [{ ...golden.components[0], props: { product_ids: ["product_001"], products: [{ price: 1 }] } }] }
  ]) assert.equal(validateGenerativeUiRequest(hostile).valid, false);
});

test("rejects correlation mismatch and missing canonical references", () => {
  const mismatch = structuredClone(golden);
  mismatch.tenant_context_ref.trace_id = "abcdefabcdefabcdefabcdefabcdefab";
  assert.equal(validateGenerativeUiRequest(mismatch).valid, false);
  const unknown = structuredClone(golden);
  unknown.components[0].props.product_ids = ["product_!"];
  assert.equal(validateGenerativeUiRequest(unknown).valid, false);
});
