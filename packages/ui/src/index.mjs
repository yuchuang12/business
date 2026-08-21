const COMPONENT_TYPES = new Set([
  "product_grid", "product_compare", "product_detail", "cart_summary",
  "lead_form", "confirm_action", "theme_picker", "domain_picker",
  "diff_preview", "workflow_status"
]);

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const TRACE = /^(?!0{32})[0-9a-f]{32}$/;
const PLAIN = /^[^<>\u0000-\u001f]*$/;
const EVENTS = /^[a-z][a-z0-9_.-]{0,79}$/;
const STATES = new Set(["ready", "loading", "empty", "error"]);
const REF_FIELDS = {
  product_grid: [["product", "product_ids"]],
  product_compare: [["product", "product_ids"]],
  product_detail: [["product", "product_id"], ["asset", "asset_ids"]],
  cart_summary: [["cart", "cart_id"]],
  lead_form: [["product", "product_ids"]],
  confirm_action: [["site", "site_id"], ["action", "action_id"], ["approval", "approval_request_id"]],
  theme_picker: [["site", "site_id"]],
  domain_picker: [["site", "site_id"]],
  diff_preview: [["site", "site_id"], ["diff", "diff_id"]],
  workflow_status: [["workflow", "workflow_id"]]
};
const COMPONENT_KEYS = new Set(["component_id", "type", "accessibility", "state", "props", "analytics"]);
const PROP_KEYS = {
  product_grid: new Set(["product_ids", "title", "columns"]),
  product_compare: new Set(["product_ids", "title"]),
  product_detail: new Set(["product_id", "asset_ids", "show_inventory"]),
  cart_summary: new Set(["cart_id", "item_count", "total", "checkout_enabled"]),
  lead_form: new Set(["form_id", "fields", "submit_action_id", "product_ids"]),
  confirm_action: new Set(["site_id", "action_id", "approval_request_id", "action_type", "summary", "consequences", "confirm_label", "cancel_label", "expires_at"]),
  theme_picker: new Set(["site_id", "presets", "selected", "select_action_id"]),
  domain_picker: new Set(["site_id", "options", "select_action_id"]),
  diff_preview: new Set(["site_id", "diff_id", "changes", "apply_action_id"]),
  workflow_status: new Set(["workflow_id", "status", "message", "steps"])
};

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validId(value) {
  return typeof value === "string" && ID.test(value);
}

function validText(value, max = 1000) {
  return typeof value === "string" && value.length > 0 && value.length <= max && PLAIN.test(value);
}

function invalid(message, path) {
  return { valid: false, errors: [{ message, path }] };
}

function validateComponent(component) {
  if (!isObject(component) || !validId(component.component_id) || !COMPONENT_TYPES.has(component.type)) {
    return invalid("component must use an approved type and id", "components");
  }
  if (Object.keys(component).some((key) => !COMPONENT_KEYS.has(key)) ||
      Object.keys(component.props ?? {}).some((key) => !PROP_KEYS[component.type].has(key))) {
    return invalid("unknown component fields are not allowed", `components.${component.component_id}`);
  }
  if (!isObject(component.accessibility) || !validText(component.accessibility.label, 160)) {
    return invalid("component accessibility.label is required", `components.${component.component_id}`);
  }
  if (!isObject(component.state) || !STATES.has(component.state.kind)) {
    return invalid("component state is invalid", `components.${component.component_id}.state`);
  }
  if (component.state.message !== undefined && !validText(component.state.message, 160)) {
    return invalid("component state.message is invalid", `components.${component.component_id}.state`);
  }
  if (component.analytics !== undefined &&
      (!isObject(component.analytics) || !EVENTS.test(component.analytics.event_name))) {
    return invalid("component analytics is invalid", `components.${component.component_id}`);
  }
  if (!isObject(component.props)) return invalid("component props are required", `components.${component.component_id}`);
  const required = {
    product_grid: ["product_ids"], product_compare: ["product_ids"], product_detail: ["product_id"],
    cart_summary: ["cart_id"], lead_form: ["form_id", "fields", "submit_action_id"],
    confirm_action: ["site_id", "action_id", "approval_request_id", "action_type", "summary", "confirm_label", "cancel_label", "expires_at"],
    theme_picker: ["site_id", "presets", "select_action_id"], domain_picker: ["site_id", "options", "select_action_id"],
    diff_preview: ["site_id", "diff_id", "changes", "apply_action_id"], workflow_status: ["workflow_id", "status", "steps"]
  }[component.type];
  if (required.some((key) => component.props[key] === undefined)) {
    return invalid("component props are incomplete", `components.${component.component_id}.props`);
  }
  if (component.type === "product_grid" && (!Array.isArray(component.props.product_ids) || component.props.product_ids.length < 1)) {
    return invalid("product_grid requires product references", `components.${component.component_id}.props`);
  }
  if (component.type === "product_compare" && (!Array.isArray(component.props.product_ids) || component.props.product_ids.length < 2)) {
    return invalid("product_compare requires two product references", `components.${component.component_id}.props`);
  }
  if (component.type === "lead_form" && (!Array.isArray(component.props.fields) || component.props.fields.length < 1)) {
    return invalid("lead_form requires fields", `components.${component.component_id}.props`);
  }
  if (component.type === "domain_picker" && (!Array.isArray(component.props.options) || component.props.options.length < 1)) {
    return invalid("domain_picker requires domain options", `components.${component.component_id}.props`);
  }
  if (component.type === "diff_preview" && (!Array.isArray(component.props.changes) || component.props.changes.length < 1)) {
    return invalid("diff_preview requires changes", `components.${component.component_id}.props`);
  }
  if (component.type === "domain_picker" && component.props.options.some((option) =>
    !isObject(option) || typeof option.domain !== "string" ||
    !/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(option.domain))) {
    return invalid("domain options are invalid", `components.${component.component_id}.props.options`);
  }
  for (const [kind, field] of REF_FIELDS[component.type]) {
    const value = component.props[field];
    if (value === undefined) continue;
    const values = Array.isArray(value) ? value : [value];
    if (!values.every(validId)) return invalid(`invalid ${kind} reference`, `components.${component.component_id}.${field}`);
  }
  return { valid: true, errors: [] };
}

/**
 * Lightweight exact-version guard for consumers that already validate with AJV.
 * It intentionally rejects unsafe values before any DOM or resolver work.
 */
export function validateGenerativeUiRequest(request) {
  if (!isObject(request) || request.contract_version !== "1.0") return invalid("unsupported GenerativeUI version", "contract_version");
  if (Object.keys(request).some((key) => !new Set(["contract_version", "ui_request_id", "tenant_context_ref", "agent_run_id", "message_id", "trace_id", "surface", "components", "fallback", "analytics"]).has(key))) {
    return invalid("unknown envelope fields are not allowed", "request");
  }
  if (!validId(request.ui_request_id) || !validId(request.agent_run_id) || !validId(request.message_id)) {
    return invalid("correlation ids are invalid", "correlation");
  }
  if (!TRACE.test(request.trace_id) || !isObject(request.tenant_context_ref) ||
      Object.keys(request.tenant_context_ref).some((key) => !new Set(["schema_version", "context_id", "tenant_id", "actor_id", "trace_id"]).has(key)) ||
      request.tenant_context_ref.schema_version !== "1.0" ||
      !validId(request.tenant_context_ref.context_id) ||
      !validId(request.tenant_context_ref.tenant_id) ||
      !validId(request.tenant_context_ref.actor_id) ||
      request.tenant_context_ref.trace_id !== request.trace_id) {
    return invalid("trusted context correlation is invalid", "tenant_context_ref");
  }
  if (!["merchant_console", "customer_site"].includes(request.surface) ||
      !Array.isArray(request.components) || request.components.length < 1 || request.components.length > 16) {
    return invalid("surface or components are invalid", "components");
  }
  if (!isObject(request.fallback) || !["message", "error", "retry_prompt"].includes(request.fallback.kind) ||
      !validText(request.fallback.text)) return invalid("fallback is invalid", "fallback");
  if (!isObject(request.analytics) || !EVENTS.test(request.analytics.event_name)) {
    return invalid("analytics is invalid", "analytics");
  }
  if (request.analytics.properties !== undefined &&
      (!isObject(request.analytics.properties) ||
       Object.values(request.analytics.properties).some((value) => !["string", "number", "boolean"].includes(typeof value) && value !== null))) {
    return invalid("analytics properties must be scalar", "analytics.properties");
  }
  for (const component of request.components) {
    const result = validateComponent(component);
    if (!result.valid) return result;
  }
  return { valid: true, errors: [] };
}

function text(document, value) {
  const node = document.createElement("span");
  node.textContent = String(value);
  return node;
}

function heading(document, value, level = 2) {
  const node = document.createElement(`h${Math.min(4, Math.max(2, level))}`);
  node.textContent = value;
  return node;
}

function stateView(document, component) {
  if (component.state.kind === "ready") return null;
  const node = document.createElement("p");
  node.setAttribute("role", component.state.kind === "error" ? "alert" : "status");
  node.className = `gen-ui-state gen-ui-state--${component.state.kind}`;
  node.textContent = component.state.message ?? {
    loading: "Loading…", empty: "Nothing to show yet.", error: "This content is unavailable."
  }[component.state.kind];
  return node;
}

function button(document, label, onClick) {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = label;
  node.addEventListener("click", onClick);
  return node;
}

function references(component) {
  const output = [];
  for (const [kind, field] of REF_FIELDS[component.type]) {
    const value = component.props[field];
    for (const id of Array.isArray(value) ? value : [value]) if (id !== undefined) output.push({ kind, id });
  }
  if (component.type === "domain_picker") {
    for (const option of component.props.options) output.push({ kind: "domain", id: option.domain });
  }
  return output;
}

async function resolveComponent(component, resolver, context) {
  const resolved = {};
  for (const reference of references(component)) {
    if (typeof resolver.resolve !== "function") throw new Error("A tenant-scoped resolver is required");
    const value = await resolver.resolve(reference.kind, reference.id, context);
    if (value === null || value === undefined) throw new Error("Referenced resource is not available");
    resolved[`${reference.kind}:${reference.id}`] = value;
  }
  return resolved;
}

function resolvedList(component, resolved, kind) {
  return (Array.isArray(component.props.product_ids) ? component.props.product_ids : [])
    .map((id) => resolved[`${kind}:${id}`]).filter(Boolean);
}

function renderComponent(document, component, resolved, emitAction) {
  const root = document.createElement("section");
  root.className = `gen-ui-component gen-ui-component--${component.type}`;
  root.setAttribute("aria-label", component.accessibility.label);
  const state = stateView(document, component);
  if (state) { root.append(state); return root; }
  const props = component.props;
  if (component.type === "product_grid" || component.type === "product_compare") {
    if (props.title) root.append(heading(document, props.title, component.accessibility.heading_level));
    const list = document.createElement("div"); list.className = "gen-ui-product-list";
    for (const product of resolvedList(component, resolved, "product")) {
      const card = document.createElement("article");
      card.append(heading(document, product.name ?? "Product", 3));
      if (product.description) card.append(text(document, product.description));
      if (product.price) card.append(text(document, `${product.price.amount_minor} ${product.price.currency}`));
      list.append(card);
    }
    root.append(list);
  } else if (component.type === "product_detail") {
    const product = resolved[`product:${props.product_id}`];
    root.append(heading(document, product.name ?? "Product", component.accessibility.heading_level));
    if (product.description) root.append(text(document, product.description));
    if (product.price) root.append(text(document, `${product.price.amount_minor} ${product.price.currency}`));
  } else if (component.type === "cart_summary") {
    root.append(heading(document, "Cart summary", component.accessibility.heading_level));
    const cart = resolved[`cart:${props.cart_id}`];
    root.append(text(document, `${cart.item_count ?? 0} items`));
    if (cart.total) root.append(text(document, `${cart.total.amount_minor} ${cart.total.currency}`));
  } else if (component.type === "lead_form") {
    const form = document.createElement("form");
    for (const field of props.fields) {
      const label = document.createElement("label"); label.textContent = field.label;
      const input = document.createElement(field.kind === "message" ? "textarea" : "input");
      input.name = field.field_id; input.required = field.required; input.id = `${component.component_id}-${field.field_id}`;
      label.htmlFor = input.id; label.append(input); form.append(label);
    }
    form.append(button(document, "Submit", () => emitAction({ action_id: props.submit_action_id, component_id: component.component_id, values: Object.fromEntries(new FormData(form)) })));
    root.append(form);
  } else if (component.type === "confirm_action") {
    root.append(heading(document, props.summary, component.accessibility.heading_level));
    if (props.consequences) root.append(text(document, props.consequences));
    root.append(button(document, props.confirm_label, () => emitAction({
      action_id: props.action_id, approval_request_id: props.approval_request_id, site_id: props.site_id,
      component_id: component.component_id, action_type: props.action_type
    })));
    root.append(button(document, props.cancel_label, () => emitAction({ action_id: props.action_id, component_id: component.component_id, cancelled: true })));
  } else if (component.type === "theme_picker") {
    root.append(heading(document, "Choose a theme", component.accessibility.heading_level));
    for (const preset of props.presets) root.append(button(document, preset, () => emitAction({ action_id: props.select_action_id, site_id: props.site_id, preset, component_id: component.component_id })));
  } else if (component.type === "domain_picker") {
    root.append(heading(document, "Choose a domain", component.accessibility.heading_level));
    for (const option of props.options) {
      const domain = resolved[`domain:${option.domain}`];
      if (domain) root.append(button(document, domain.domain, () => emitAction({ action_id: props.select_action_id, site_id: props.site_id, domain: domain.domain, component_id: component.component_id })));
    }
  } else if (component.type === "diff_preview") {
    root.append(heading(document, "Review changes", component.accessibility.heading_level));
    for (const change of props.changes) root.append(text(document, `${change.kind}: ${change.summary}`));
    root.append(button(document, "Apply changes", () => emitAction({ action_id: props.apply_action_id, site_id: props.site_id, diff_id: props.diff_id, component_id: component.component_id })));
  } else if (component.type === "workflow_status") {
    root.append(heading(document, props.message ?? `Workflow: ${props.status}`, component.accessibility.heading_level));
    const list = document.createElement("ul");
    for (const step of props.steps) { const item = document.createElement("li"); item.textContent = `${step.label}: ${step.status}`; list.append(item); }
    root.append(list);
  }
  return root;
}

export function createGenerativeUiRenderer({ document, resolver, analytics = () => {}, onAction = () => {} }) {
  if (!document || !resolver) throw new TypeError("document and tenant-scoped resolver are required");
  return {
    async render(request, mount) {
      const validation = validateGenerativeUiRequest(request);
      if (!validation.valid) throw new Error(validation.errors[0].message);
      const context = request.tenant_context_ref;
      const root = document.createElement("div");
      root.className = "gen-ui-request";
      for (const component of request.components) {
        try {
          const resolved = await resolveComponent(component, resolver, context);
          root.append(renderComponent(document, component, resolved, (action) => onAction({
            ...action, tenant_id: context.tenant_id, agent_run_id: request.agent_run_id,
            message_id: request.message_id, trace_id: request.trace_id
          })));
          analytics({ event_name: component.analytics?.event_name ?? "agent_ui.component_render", tenant_id: context.tenant_id,
            agent_run_id: request.agent_run_id, message_id: request.message_id, trace_id: request.trace_id,
            component_type: component.type, component_id: component.component_id });
        } catch {
          const fallback = document.createElement("p");
          fallback.setAttribute("role", "alert");
          fallback.textContent = request.fallback.text;
          root.append(fallback);
        }
      }
      mount.replaceChildren(root);
      return root;
    }
  };
}
