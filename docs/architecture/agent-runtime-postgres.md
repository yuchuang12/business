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
```

`DATABASE_URL` is preferred. Without it, `PGHOST`, `PGPORT`, `PGUSER`,
`PGPASSWORD`, `PGDATABASE`, and optional `PGSSLMODE` are used. Production must
provide PostgreSQL; `NewInMemoryRuntimeStore` remains a deterministic unit-test
fixture and is not selected by the production bootstrap.

`Migrate` is idempotent and records applied files in
`agent_runtime_schema_migrations` in the same transaction as the migration.
Rollback is performed by deploying the previous application/schema version;
the migration is not edited in place.

Integration tests can call `NewPostgresTestDatabase(t)`. They require
`TEST_DATABASE_ADMIN_URL` (or `DATABASE_URL`), create a uniquely named database,
apply the owned migration, and drop the database during cleanup. Tests without
PostgreSQL configuration are skipped rather than connecting to a shared
database.
