import { assertBusinessInput, requireTenantContext } from "./context.mjs";
import { fail } from "./errors.mjs";

export class TenantRepository {
  constructor(store, table, prefix) {
    this.store = store;
    this.table = table;
    this.prefix = prefix;
  }

  get(context, id) {
    const trusted = requireTenantContext(context);
    const record = this.store.get(this.table, id);
    if (!record || record.tenant_id !== trusted.tenant_id) {
      fail("COMMERCE_NOT_FOUND", "Resource is not visible.");
    }
    return structuredClone(record);
  }

  list(context, { page = 1, pageSize = 20, filter = () => true } = {}) {
    const trusted = requireTenantContext(context);
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      fail("COMMERCE_INVALID_REQUEST", "Pagination is invalid.");
    }
    const records = this.store.list(this.table)
      .filter((record) => record.tenant_id === trusted.tenant_id && filter(record));
    const start = (page - 1) * pageSize;
    return { items: records.slice(start, start + pageSize), page, page_size: pageSize, total: records.length, has_next: start + pageSize < records.length };
  }

  create(context, input, fields = {}) {
    const trusted = requireTenantContext(context);
    assertBusinessInput(input);
    const id = `${this.prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
    const safeInput = structuredClone(input);
    delete safeInput.id;
    delete safeInput[`${this.prefix}_id`];
    const record = { ...safeInput, ...fields, id, [`${this.prefix}_id`]: id, tenant_id: trusted.tenant_id, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    this.store.put(this.table, record);
    return structuredClone(record);
  }

  update(context, id, changes) {
    const current = this.get(context, id);
    assertBusinessInput(changes);
    const safeChanges = structuredClone(changes);
    delete safeChanges.id;
    delete safeChanges[`${this.prefix}_id`];
    const updated = { ...current, ...safeChanges, id: current.id, [`${this.prefix}_id`]: current[`${this.prefix}_id`] ?? current.id, tenant_id: current.tenant_id, updated_at: new Date().toISOString() };
    this.store.put(this.table, updated);
    return structuredClone(updated);
  }
}
