import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

const contractRoot = new URL("../../contracts/", import.meta.url);

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, contractRoot), "utf8"));
}

const themeSchema = await readJson("theme-token/v1/theme-token.schema.json");
const siteSchema = await readJson("site-schema/v1/site-schema.schema.json");
const example = await readJson("site-schema/v1/examples/golden-path.json");
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(themeSchema);
const validate = ajv.compile(siteSchema);

function assertValid(value) {
  assert.equal(validate(value), true, JSON.stringify(validate.errors, null, 2));
}

function assertInvalid(value) {
  assert.equal(validate(value), false, "expected schema validation to fail");
}

test("Golden Path SiteSchema and ThemeToken validate", () => {
  assertValid(example);
});

test("unknown sections and unsafe props fail closed", () => {
  const unknownSection = structuredClone(example);
  unknownSection.pages[0].sections[0].type = "arbitrary_component";
  assertInvalid(unknownSection);

  const unsafeProps = structuredClone(example);
  unsafeProps.pages[0].sections[0].props.onClick = "alert(1)";
  assertInvalid(unsafeProps);

  const htmlText = structuredClone(example);
  htmlText.pages[0].sections[0].props.headline = "<script>alert(1)</script>";
  assertInvalid(htmlText);
});

test("references and responsive values remain constrained data", () => {
  const badReference = structuredClone(example);
  badReference.pages[0].sections[1].props.tenant_id = "ten_other";
  assertInvalid(badReference);

  const badLayout = structuredClone(example);
  badLayout.pages[0].sections[0].layout.responsive.mobile.columns = 12;
  assertInvalid(badLayout);

  const badUrl = structuredClone(example);
  badUrl.navigation[0].destination = { url: "javascript:alert(1)" };
  assertInvalid(badUrl);
});

test("theme presets and token values are closed", () => {
  const badPreset = structuredClone(example);
  badPreset.theme.preset = "custom";
  assertInvalid(badPreset);

  const badColor = structuredClone(example);
  badColor.theme.colors.primary = "var(--danger)";
  assertInvalid(badColor);
});
