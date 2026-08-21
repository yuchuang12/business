export class InMemoryCommerceStore {
  constructor() {
    this.tables = new Map([
      ["merchants", new Map()], ["sites", new Map()], ["products", new Map()],
      ["categories", new Map()], ["assets", new Map()], ["customers", new Map()],
      ["carts", new Map()], ["orders", new Map()], ["leads", new Map()]
    ]);
    this.idempotency = new Map();
    this.audit = [];
  }

  table(name) { return this.tables.get(name); }
  put(table, record) { this.table(table).set(record.id, structuredClone(record)); return record; }
  get(table, id) { return this.table(table).get(id); }
  list(table) { return [...this.table(table).values()].map((record) => structuredClone(record)); }
  recordAudit(entry) { this.audit.push(structuredClone(entry)); }
}
