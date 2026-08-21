# Commerce golden-path fixtures

`CommerceFixture` is a deterministic, in-memory adapter for the YUC-15
integration slice. It exposes a tenant-scoped product lookup and approval-backed
cart/lead actions without provider calls or changes to public contracts.

The fixture preserves the canonical `site_pet_store`, `product_pet_food`,
`approval_pet_store_action_001`, and `action_pet_store_001` identifiers. Every
operation requires a trusted TenantContext, checks resource ownership, carries
the trace identifier, and uses an idempotency key for action requests.

Run the focused contract tests with:

```sh
node --test tests/commerce-golden-path.test.mjs
```
