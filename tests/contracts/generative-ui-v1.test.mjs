import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

const contractRoot = new URL("../../contracts/", import.meta.url);

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, contractRoot), "utf8"));
}

const schema = await readJson("generative-ui/v1/generative-ui.schema.json");
const example = await readJson("generative-ui/v1/examples/golden-path.json");
const ajv = new Ajv2020({ allErrors: true, strict: true, formats: { "date-time": true } });
const validate = ajv.compile(schema);

function assertValid(value) {
  assert.equal(validate(value), true, JSON.stringify(validate.errors, null, 2));
}

function assertInvalid(value) {
  assert.equal(validate(value), false, "expected schema validation to fail");
}

test("Golden Path represents customer and high-risk workflow UI", () => {
  assertValid(example);
  assert.deepEqual(
    example.components.map((component) => component.type),
    ["product_grid", "confirm_action", "workflow_status"]
  );
});

test("all approved component types have typed payloads", async () => {
  const componentTypes = [
    "product_grid", "product_compare", "product_detail", "cart_summary",
    "lead_form", "confirm_action", "theme_picker", "domain_picker",
    "diff_preview", "workflow_status"
  ];
  const base = structuredClone(example);
  for (const [index, type] of componentTypes.entries()) {
    const component = structuredClone(base.components[0]);
    component.component_id = `component_${index}`;
    component.type = type;
    component.props = {
      product_compare: { product_ids: ["product_001", "product_002"] },
      product_detail: { product_id: "product_001" },
      cart_summary: { cart_id: "cart_001" },
      lead_form: {
        form_id: "form_001",
        fields: [{ field_id: "email", label: "Email", kind: "email", required: true }],
        submit_action_id: "action_002"
      },
      confirm_action: {
        site_id: "site_001",
        action_id: "action_001", approval_request_id: "approval_001",
        action_type: "publish_site", summary: "Publish", confirm_label: "Confirm",
        cancel_label: "Cancel", expires_at: "2026-08-22T12:00:00Z"
      },
      theme_picker: { site_id: "site_001", presets: ["minimal", "premium"], select_action_id: "action_003" },
      domain_picker: {
        site_id: "site_001",
        options: [{ domain: "shop.example.com", availability: "available", price: { amount_minor: 100, currency: "USD" } }],
        select_action_id: "action_004"
      },
      diff_preview: {
        site_id: "site_001",
        diff_id: "diff_001", changes: [{ path: "/pages/home", kind: "update", summary: "Update homepage" }],
        apply_action_id: "action_005"
      },
      workflow_status: {
        workflow_id: "workflow_001", status: "running",
        steps: [{ step_id: "step_001", label: "Import", status: "running" }]
      }
    }[type] ?? { product_ids: ["product_001"] };
    assertValid({ ...base, components: [component] });
  }
});

test("unsafe executable, fabricated, and open-ended payloads fail closed", () => {
  const html = structuredClone(example);
  html.fallback.text = "<script>alert(1)</script>";
  assertInvalid(html);

  const callback = structuredClone(example);
  callback.components[0].props.onClick = "publish_site";
  assertInvalid(callback);

  const productObject = structuredClone(example);
  productObject.components[0].props.products = [{ product_id: "product_001", price: 1 }];
  assertInvalid(productObject);

  const invalidTrace = structuredClone(example);
  invalidTrace.tenant_context_ref.trace_id = "00000000000000000000000000000000";
  assertInvalid(invalidTrace);

  const unknownComponent = structuredClone(example);
  unknownComponent.components[0].type = "arbitrary_html";
  assertInvalid(unknownComponent);
});

test("loading, empty, and error states require safe bounded messages", () => {
  for (const kind of ["loading", "empty", "error"]) {
    const value = structuredClone(example);
    value.components[0].state = { kind, message: `${kind} products` };
    if (kind === "error") value.components[0].state.error_code = "PRODUCTS_UNAVAILABLE";
    assertValid(value);
  }

  const invalid = structuredClone(example);
  invalid.components[0].state = { kind: "error", message: "<bad>" };
  assertInvalid(invalid);
});
