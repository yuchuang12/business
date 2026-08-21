CREATE TABLE merchants (
  merchant_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE sites (
  site_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, merchant_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  schema_json JSONB, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE categories (
  category_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE products (
  product_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, category_id TEXT,
  sku TEXT, name TEXT NOT NULL, description TEXT, price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'USD', created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE assets (
  asset_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, storage_key TEXT NOT NULL,
  mime_type TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE customers (
  customer_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, email TEXT, phone TEXT,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE carts (
  cart_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, customer_id TEXT, items JSONB NOT NULL DEFAULT '[]',
  currency TEXT NOT NULL DEFAULT 'USD', created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE orders (
  order_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, cart_id TEXT NOT NULL, items JSONB NOT NULL,
  total_minor INTEGER NOT NULL CHECK (total_minor >= 0), status TEXT NOT NULL, approval_reference JSONB,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE leads (
  lead_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, email TEXT, phone TEXT, product_ids JSONB,
  summary TEXT, idempotency_key TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX commerce_tenant_lookup ON products (tenant_id, product_id);
CREATE INDEX commerce_tenant_status ON orders (tenant_id, status);
