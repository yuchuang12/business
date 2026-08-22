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

`CommerceProviderClient` is the production HTTP adapter. It resolves credentials
by trusted `TenantContext`, sends only tenant and trace correlation metadata,
uses bounded retries for retryable failures, and never caches provider data.
`createApprovedProviderOrder` requires the existing approval validator and
reconciles an unknown in-flight write by idempotency key before reporting
failure. `FakeCommerceProvider` is the deterministic CI adapter.

## Catalog operations

`CommerceService` exposes tenant-scoped `createProduct`, `getProduct`,
`listProducts`, `updateProduct`, `createCategory`, `getCategory`,
`listCategories`, and `updateCategory` operations. Product writes validate
names, SKU uniqueness, ISO currency codes, prices, and category ownership.

`importProducts(context, { rows, idempotency_key })` accepts already-parsed CSV or
spreadsheet rows. Each row must contain `name`, `sku`, `price` (or integer
`price_minor`), and `currency`; optional `image`, `images`, `description`, and
`category_id` values are preserved after tenant validation. The result contains
`imported`, `updated`, `failed`, `success_count`, `failure_count`, and
row-numbered `errors`. The idempotency key is tenant-scoped; replay returns the
original result, while a changed payload returns `COMMERCE_CONFLICT`.

The backend implementation is the Go package `github.com/yuchuang12/business/packages/commerce`.
Its typed API (`CommerceService`, `ProductInput`, `ImportRequest`, and
`ImportResult`) uses `InMemoryCommerceStore` for deterministic CI tests and does
not parse files or contact cloud resources.
