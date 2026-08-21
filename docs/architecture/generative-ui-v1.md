# GenerativeUI v1 Architecture

- Status: accepted
- Contract: `contracts/generative-ui/v1/generative-ui.schema.json`
- Related issue: YUC-9
- Decision record: `docs/adr/0006-generative-ui-v1.md`

## Boundary

```text
Agent message
    |
    v
GenerativeUI schema validation
    |
    +--> trusted TenantContext + resource resolution
    |       (Product / Asset / Cart / Site / Approval)
    |
    v
registered renderer -> accessible UI
```

GenerativeUI is a presentation protocol only. The model can select an approved
component and provide opaque references, but it cannot create domain records,
provide authoritative commerce values, call a Tool, or submit an arbitrary
event target. The renderer is not a second policy engine: action events are
returned to the application, and the Tool Executor performs policy,
authorization, approval, idempotency, audit, and execution checks.

## Envelope invariants

- `contract_version` is exact `1.0`; unknown versions and fields fail closed.
- `tenant_context_ref`, `agent_run_id`, `message_id`, and `trace_id` correlate
  the request. Authorization always uses the trusted context supplied out of
  band, and correlation mismatches are rejected.
- Every component has a closed `type`, an accessibility label, and an explicit
  state. The envelope has safe fallback text for unsupported or failed renders.
- Analytics contains only an allow-listed event name and scalar, non-sensitive
  properties. It is observational and cannot contain executable instructions.

## Data and security rules

Product, asset, cart, site, workflow, action, and approval references are opaque
IDs. The application resolves each one inside `context.tenant_id`; a missing or
foreign reference is not replaced with generated data. Product prices,
inventory, domain quotes, and other commerce facts come from canonical backend
records at render time.

The schema has no HTML, CSS, JavaScript, callback, arbitrary component, or
executable URL fields. Domain names are constrained hostnames. Text rejects
markup/control characters. The renderer must still apply output encoding and
component-level accessibility checks.

## High-risk and workflow surfaces

`confirm_action` references an existing approval and action. Its fields are a
human-readable summary, consequences, labels, and expiry only. Rendering or
clicking it does not execute the action; the application must send a new
typed Tool request through the same approval/idempotency path. `workflow_status`
and `diff_preview` expose persisted status and change summaries without
accepting executable workflow or patch content.

## Validation and failure handling

Validation occurs before resource resolution and rendering. Resource resolution
and authorization failures use the same not-visible behavior as other
tenant-scoped resources and are audit logged by the application. A component
that cannot be safely hydrated is not silently replaced; the renderer displays
the envelope fallback or an explicit error state. The P0 E2E suite will later
cover mobile rendering, keyboard interaction, approval non-execution, and
cross-tenant reference rejection.
