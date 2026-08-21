import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CommerceFixture, FIXTURE_CONTEXT, IDS } from "../../packages/commerce/src/golden-path-fixtures.mjs";
import { SiteEngineService } from "../../packages/site-engine/src/index.mjs";
import { createGenerativeUiRenderer } from "../../packages/ui/src/index.mjs";

const siteSchema = JSON.parse(await readFile(new URL("../../contracts/site-schema/v1/examples/golden-path.json", import.meta.url)));
const generativeUi = JSON.parse(await readFile(new URL("../../contracts/generative-ui/v1/examples/golden-path.json", import.meta.url)));

class Element {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.className = "";
    this.textContent = "";
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = children;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  addEventListener(name, handler) {
    this.listeners[name] = handler;
  }

  click() {
    this.listeners.click?.();
  }
}

const document = { createElement: (tagName) => new Element(tagName) };

function textContent(node) {
  return [node.textContent, ...node.children.map(textContent)].filter(Boolean).join(" ");
}

function findAll(node, tagName) {
  return [
    ...(node.tagName === tagName.toUpperCase() ? [node] : []),
    ...node.children.flatMap((child) => findAll(child, tagName))
  ];
}

function requestWith(overrides = {}) {
  const request = structuredClone(generativeUi);
  request.tenant_context_ref = {
    ...request.tenant_context_ref,
    tenant_id: FIXTURE_CONTEXT.tenant_id,
    actor_id: FIXTURE_CONTEXT.actor_id,
    trace_id: FIXTURE_CONTEXT.trace_id
  };
  request.trace_id = FIXTURE_CONTEXT.trace_id;
  request.components = request.components.map((component) => {
    if (component.type === "product_grid") {
      return { ...component, props: { ...component.props, product_ids: [IDS.product] } };
    }
    if (component.type === "confirm_action") {
      return { ...component, props: { ...component.props, site_id: IDS.site } };
    }
    return component;
  });
  return { ...request, ...overrides };
}

function makeResolver(commerce) {
  return {
    async resolve(kind, id, context) {
      if (context.tenant_id !== FIXTURE_CONTEXT.tenant_id) return null;
      if (kind === "product") {
        const result = commerce.lookupProduct(FIXTURE_CONTEXT, { product_id: id });
        if (!result.success) return null;
        const product = result.data.product;
        return {
          id: product.id,
          tenant_id: product.tenant_id,
          name: product.name,
          description: "Everyday nutrition for happy pets.",
          price: { amount_minor: product.price, currency: product.currency }
        };
      }
      if (kind === "site" && id === IDS.site) return { id, tenant_id: context.tenant_id };
      if (kind === "approval" && id === IDS.approval) return { id, tenant_id: context.tenant_id };
      return { id, tenant_id: context.tenant_id };
    },
    async resolveAsset(context, id) { return this.resolve("asset", id, context); },
    async resolveProduct(context, id) { return this.resolve("product", id, context); },
    async resolveCategory(context, id) { return this.resolve("category", id, context); }
  };
}

test("Site Engine publication and UI renderer share tenant-scoped canonical products", async () => {
  const commerce = new CommerceFixture();
  const resolver = makeResolver(commerce);
  const schema = structuredClone(siteSchema);
  schema.pages[1].sections[0].props.product_ids = [IDS.product];
  const engine = new SiteEngineService({ resolver });
  const published = await engine.publish(FIXTURE_CONTEXT, schema);
  assert.equal(published.tenant_id, FIXTURE_CONTEXT.tenant_id);

  const actions = [];
  const renderer = createGenerativeUiRenderer({
    document,
    resolver,
    onAction: (action) => actions.push(action)
  });
  const mount = new Element("main");
  const request = requestWith({
    components: [
      {
        component_id: "grid_001",
        type: "product_grid",
        accessibility: { label: "Recommended products", heading_level: 2 },
        state: { kind: "ready" },
        props: { product_ids: [IDS.product], title: "Recommended products" }
      },
      {
        component_id: "detail_001",
        type: "product_detail",
        accessibility: { label: "Product details", heading_level: 2 },
        state: { kind: "ready" },
        props: { product_id: IDS.product }
      },
      requestWith().components[1]
    ]
  });
  await renderer.render(request, mount);
  assert.match(textContent(mount), /Everyday Pet Food/);
  assert.match(textContent(mount), /2999 CNY/);
  assert.equal(findAll(mount, "section").length, 3);

  const confirmButton = findAll(mount, "button").find((button) => button.textContent === "Publish");
  confirmButton.click();
  assert.equal(actions.length, 1);
  assert.equal(actions[0].approval_request_id, "approval_001");
  assert.equal(actions[0].tenant_id, FIXTURE_CONTEXT.tenant_id);
});

test("loading, empty, error, accessibility, and fallback paths stay data-only", async () => {
  const commerce = new CommerceFixture();
  const renderer = createGenerativeUiRenderer({ document, resolver: makeResolver(commerce) });
  const mount = new Element("main");
  const request = requestWith({
    components: [
      {
        component_id: "loading_001", type: "product_detail",
        accessibility: { label: "Loading product", heading_level: 2 },
        state: { kind: "loading", message: "Loading product..." },
        props: { product_id: IDS.product }
      },
      {
        component_id: "empty_001", type: "product_grid",
        accessibility: { label: "Empty recommendations" },
        state: { kind: "empty", message: "No recommendations." },
        props: { product_ids: [IDS.product] }
      },
      {
        component_id: "error_001", type: "product_detail",
        accessibility: { label: "Unavailable product" },
        state: { kind: "error", message: "Product unavailable." },
        props: { product_id: "product_missing" }
      }
    ]
  });
  await renderer.render(request, mount);
  assert.match(textContent(mount), /Loading product/);
  assert.match(textContent(mount), /No recommendations/);
  assert.equal(findAll(mount, "p").filter((node) => node.attributes.role === "alert").length, 1);
  assert.equal(findAll(mount, "section")[0].attributes["aria-label"], "Loading product");

  const hostile = requestWith({
    components: [{ ...request.components[0], type: "arbitrary_html" }]
  });
  await assert.rejects(() => renderer.render(hostile, mount), /approved type/);
});
