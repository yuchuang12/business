# GenerativeUI v1

- Contract version: `1.0`
- Schema: `generative-ui.schema.json`
- Status: frozen
- Related issue: YUC-9
- Decision record: `docs/adr/0006-generative-ui-v1.md`

GenerativeUI is a data-only request from an Agent to a trusted renderer. It is
not a command channel and cannot execute tools, mutate commerce data, or bypass
approval policy. The renderer selects components from the closed union and
resolves every opaque reference under the trusted `TenantContext`.

## Envelope and correlation

Every request carries `ui_request_id`, `agent_run_id`, `message_id`, the
`tenant_context_ref`, and the same `trace_id` as the AgentRun. The context
reference is correlation metadata, not authorization; the renderer must obtain
the trusted immutable context out of band and reject mismatches.

Unknown fields, versions, component types, states, URLs, executable-looking
content, and malformed references fail closed. Product cards, comparisons,
details, carts, leads, and domain offers contain IDs and backend-derived
values; the model cannot supply product, price, inventory, or asset objects.

## Component union

The v1 union supports:

`product_grid`, `product_compare`, `product_detail`, `cart_summary`,
`lead_form`, `confirm_action`, `theme_picker`, `domain_picker`, `diff_preview`,
and `workflow_status`.

All components have an accessibility label and an explicit `ready`, `loading`,
`empty`, or `error` state. The envelope includes a safe text fallback for
unsupported data or rendering failure and an analytics hook containing event
names and non-sensitive scalar properties.

`confirm_action` describes the approved action and references an existing
`approval_request_id` and `action_id`. A click may emit a renderer event, but
only the Tool Executor can validate approval and execute the action. `diff_preview`
is similarly a review surface; it is not a patch or executable payload.

## Resolution and rendering rules

1. Validate the envelope and component payload with the exact `1.0` schema.
2. Resolve `product_id`, `asset_id`, `cart_id`, `site_id`, workflow and action
   references under the trusted tenant. Missing or foreign references fail the
   component; never fabricate a replacement.
3. Hydrate prices, inventory, product text, and domain quotes from canonical
   backend records. Model-authored values are not authoritative.
4. Render with the registered component map only. Do not evaluate HTML, CSS,
   JavaScript, event handlers, arbitrary URLs, or component names from input.
5. Preserve keyboard access, visible labels, focus order, and the explicit
   loading/empty/error state. On failure, show `fallback` text and record the
   correlated analytics event without leaking tenant or personal data.

Compatibility follows the repository contract rule: consumers select the exact
declared version and fail closed for unknown versions. Additive vocabulary or
semantic changes require a negotiated minor version; incompatible changes
require a new major version and ADR. Existing requests remain interpretable by
their declared version.
