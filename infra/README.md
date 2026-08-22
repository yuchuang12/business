# Infrastructure

MVP 采用单一供应商链路、模块化单体和共享多租户运行时。禁止在没有现有环境强制要求的情况下引入 Kubernetes、Kafka/Pulsar、服务网格、自建模型推理集群或每商户独立基础设施。

## Staging runtime baseline

The Agent Runtime persists lifecycle, idempotency, and audit references in
PostgreSQL. The checked-in Compose file intentionally runs only PostgreSQL:
this repository currently provides a Go runtime package, not an HTTP server
binary. An application composition root must create one shared database handle,
run migrations before accepting traffic, inject a `PostgresRuntimeStore`, and
close the handle on `SIGTERM` before its shutdown deadline.

### Configuration and secrets

Copy the ignored example and use the deployment platform's secret store to
write the real `.env` file at deploy time:

```sh
cp infra/staging/.env.example infra/staging/.env
chmod 600 infra/staging/.env
```

`POSTGRES_PASSWORD`, `DATABASE_URL`, and `PGPASSWORD` are secrets. Do not put
them in Git, issue comments, logs, command histories, or metrics labels. The
runtime accepts `DATABASE_URL`, or `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`,
`PGDATABASE`, and `PGSSLMODE`. Local Compose uses `PGSSLMODE=disable`; managed
staging PostgreSQL must use TLS (`require` at minimum, `verify-full` when the
provider supplies a CA).

### Repeatable staging release

From the repository root, start the database and wait for its health check:

```sh
docker compose --env-file infra/staging/.env -f infra/staging/compose.yaml up -d postgres
docker compose --env-file infra/staging/.env -f infra/staging/compose.yaml ps
```

Export only the runtime connection inputs for the one-shot admin command, then
apply the embedded, transactional migrations and verify readiness:

```sh
set -a
. infra/staging/.env
set +a
export PGHOST=127.0.0.1 PGPORT="$POSTGRES_PORT" PGDATABASE="$POSTGRES_DB" PGUSER="$POSTGRES_USER"
go run ./cmd/runtime-admin migrate
go run ./cmd/runtime-admin health
```

`migrate` is idempotent and its migration ledger commits in the same
transaction as each schema change. Run it as a pre-deploy job; application
instances must not accept traffic until it succeeds. The Compose database is
loopback-bound and has a health check, restart policy, no-new-privileges, and
CPU/memory limits. Production should apply equivalent limits and use a managed
PostgreSQL service with encrypted backups.

### Rollback, backup, and recovery

Migrations are forward-only and must never be edited after release. A safe
application rollback deploys the preceding compatible application version.
For a destructive or incompatible future migration, take and verify a backup
before migration, then restore rather than running an unreviewed down script.

```sh
mkdir -p .local-backups
infra/staging/backup.sh .local-backups/pre-release.dump
# Restore only during an incident or the scheduled drill.
infra/staging/restore.sh .local-backups/pre-release.dump
```

The restore operation replaces database objects in the configured staging
database. Execute recovery drills against a disposable staging database:
restore a backup, run `go run ./cmd/runtime-admin migrate`, verify `health`,
and run the Agent Runtime PostgreSQL integration test with a dedicated
`TEST_DATABASE_ADMIN_URL`. Retain encrypted daily backups for 35 days and
monthly backups for 12 months; restrict restoration to the production
operations role and record each restore in the incident audit trail.

### Operations, observability, and shutdown

Use the `runtime-admin health` command as the database readiness dependency;
the future HTTP process must expose separate liveness (process event loop
alive) and readiness (database reachable and migrations current) endpoints.
On `SIGTERM`, first stop accepting new work, allow the configured grace period
for in-flight work, persist cooperative cancellation/recovery state, then
close the shared `*sql.DB`. Do not force-retry unknown in-flight provider
effects: the runtime's recovery path fails them closed until reconciliation.

Emit structured JSON logs with `trace_id`, `tenant_id`, `agent_run_id`,
`tool_execution_id`, `audit_id`, and `correlation_id` when available. Never
emit prompts, tool payloads, provider payloads, credentials, uploaded
documents, or personal contact data. Link traces, metrics, and logs with the
same trace ID. Minimum staging dashboards/alerts are:

| Signal | SLO / alert |
| --- | --- |
| Runtime readiness | 99.9% monthly; page after 5 minutes not ready |
| Tool success rate | >= 95% over 1 hour; warn below target |
| Retry and unknown in-flight effects | alert on any sustained growth; investigate before retrying |
| p95 tool latency and approval wait | track by tool and outcome; warn on 2x the 7-day baseline |
| Database backup | page if no successful daily backup in 26 hours |

Keep audit references and tenant-safe trace identifiers for 13 months. Apply
the retention/deletion policy only to referenced redacted payload stores; do
not add raw payloads to lifecycle records or operational telemetry.
