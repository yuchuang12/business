# ThemeToken v1

- Contract version: `1.0`
- Schema: `theme-token.schema.json`
- Status: frozen
- Related issue: YUC-6
- Decision record: `docs/adr/0003-site-schema-and-theme-token-v1.md`

`ThemeToken` is a closed, data-only design-token object. The five MVP presets are
`minimal`, `tech`, `premium`, `natural`, and `vibrant`. Consumers must map these
tokens to the renderer's existing design system; values are not CSS, class names,
selectors, URLs, or executable code.

The schema fixes the color, typography, spacing, radius, and density vocabulary.
Unknown fields and values fail closed. A new token or preset requires an explicitly
negotiated contract version.
