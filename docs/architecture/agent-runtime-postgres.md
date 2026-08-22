# Agent Runtime PostgreSQL infrastructure

`packages/agent-runtime` owns the `001_agent_runtime.sql` schema. The
application composition root opens one shared `*sql.DB`, calls `Migrate` during
startup, injects that connection into the runtime persistence implementation,
and closes it during shutdown:

```go
db, err := agentruntime.OpenPostgres(ctx, agentruntime.PostgresConfigFromEnv())
if err != nil { return err }
defer db.Close()
if err := agentruntime.Migrate(ctx, db); err != nil { return err }
store, err := agentruntime.NewPostgresRuntimeStore(db)
if err != nil { return err }
```

`DATABASE_URL` is preferred. Without it, `PGHOST`, `PGPORT`, `PGUSER`,
`PGPASSWORD`, `PGDATABASE`, and optional `PGSSLMODE` are used. Production must
provide PostgreSQL; `NewInMemoryRuntimeStore` remains a deterministic unit-test
fixture and is not selected by the production bootstrap.

`Migrate` is idempotent and records applied files in
`agent_runtime_schema_migrations` in the same transaction as the migration.
Rollback is performed by deploying the previous application/schema version;
the migration is not edited in place.

`PostgresRuntimeStore` is the production durable-worker adapter. It atomically
claims idempotency scopes and provider effects, leases running work during
recovery with `FOR UPDATE SKIP LOCKED`, and persists reconciliation outcomes.
An absent or unrecorded provider reconciliation is returned as
`unknown_in_flight`; callers must not auto-retry it.

Integration tests can call `NewPostgresTestDatabase(t)`. They require
`TEST_DATABASE_ADMIN_URL` (or `DATABASE_URL`), create a uniquely named database,
apply the owned migration, and drop the database during cleanup. Tests without
PostgreSQL configuration are skipped rather than connecting to a shared
database.

Validate the adapter locally with:

```sh
go test ./packages/agent-runtime
go test -race ./packages/agent-runtime
```
