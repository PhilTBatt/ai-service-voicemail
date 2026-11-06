# 008: Job queue (pg-boss) and the sync-agent job

- **Date:** 2026-11-06
- **Status:** accepted
- **Code:** `apps/api/src/jobs/`, `apps/api/src/worker.ts`, migration `20261106200000_install_pgboss.sql`

## Context

BUILD_PLAN names pg-boss for jobs, with every job idempotent. Step 3's first job is `sync-agent`: when a profile is saved, build the agent on the voice platform; idempotent on tenant plus profile version; store the agent ID and sync time, or the error; alert on failure.

Two constraints shaped the design:

- **The app role can't create database objects** (decision 004), but pg-boss creates its own schema with 13 tables and 6 functions, and creates more objects at runtime.
- **Row-level security** means the job must run inside `withTenant()` to read a tenant's rows.

## Decisions

### 1. pg-boss owns its own schema, as the app role

A migration runs pg-boss's own install SQL (`getConstructionPlans("pgboss")`, pg-boss 12.38.1) **as the app role**, via `SET ROLE callmate_app`. The migration creates the schema and hands it to the app role first, since pg-boss's own `CREATE SCHEMA IF NOT EXISTS` fails without the database-level `CREATE` privilege even when the schema exists (verified on the test database).

- `roles.sql` grants `callmate_app` to `callmate_owner`, so migrations can switch role.
- The migration runs with dbmate's `transaction:false`, because pg-boss's SQL manages its own transaction.
- pg-boss starts with `migrate: false, createSchema: false`: it never alters the database at runtime, and refuses to start if its schema version doesn't match the package. Upgrading pg-boss means a new migration from `getMigrationPlans()`.

Options discarded:

- **Grant the app role piecemeal rights on a schema the owner creates.** pg-boss creates partition tables and runs maintenance at runtime; keeping the grants complete would be fragile.
- **A separate worker role.** Adds a credential for no isolation gain: the queue holds only tenant IDs and version numbers.
- **`migrate: true` with the owner's credentials in the worker.** Breaks "the app never holds the owner's credentials".

### 2. Idempotency on tenant plus profile version, at two levels

- **Queue:** the `sync-agent` queue uses pg-boss's `exclusive` policy with `singletonKey = "<tenantId>:<version>"`, so at most one job per tenant and version is queued or active. A second `send` returns `null`.
- **Job:** it skips a version whose `synced_at` is already set, so a retry after a crash can't create a second agent.

### 3. No database transaction around the platform call

The job reads in one `withTenant()` transaction, calls the platform with nothing open (an HTTP call can take seconds and would hold a pooled connection), then writes the result in a second transaction.

### 4. Failures: record, alert, rethrow

A failed sync stores `sync_error` on the profile row, raises an alert (`agent-sync-failed`), and rethrows so pg-boss retries with backoff (5 attempts) and finally moves the job to the `dead-letter` queue. Alerts are error-level log lines carrying an `alert` field; Step 8 routes them to Phil's phone.

### 5. Enqueue after commit, not inside the save's transaction

`saveAgentProfile` commits the new version, then enqueues. pg-boss can enqueue inside a caller's transaction (its `db` option takes any object with `executeSql`, so a transaction client can be wrapped), which Step 5 needs for calls and will verify. For profile saves, a crash in the gap would leave a version unsynced until the next save; a reconciler for unsynced profiles can be added if that ever happens.

**Confidence:** high for 1–4; medium for 5.

**Strongest case against:** pg-boss's schema version is now pinned by a migration, so a pg-boss upgrade is a two-step change (package, then migration) and `start()` fails loudly in between. That's deliberate, but it's a trap for whoever upgrades without reading this.

## Not mapped yet

- `wrapUpAfterSeconds` (Retell has no wrap-up timer): Step 7.
- Anything in the dead-letter queue should alert: Step 5.
- The `tenants.contact_name` column is nullable until onboarding (Step 11) collects it; the sync job refuses to build an agent without it.
