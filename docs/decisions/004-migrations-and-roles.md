# 004: Migration tool and database roles

- **Date:** 2026-11-04
- **Status:** accepted

## Context

BUILD_PLAN Step 1 asks for:

- plain SQL migrations, with the tool choice justified
- two database roles: a migration owner, and an app role that isn't the table owner, isn't a superuser and has no BYPASSRLS

Migrations must run from Windows PowerShell, on Linux CI and, in Step 8, as a separate deploy job using the owner role.

## Decision

### Migrations: [dbmate](https://github.com/amacneil/dbmate) 2.37

- Migrations are plain SQL files in `apps/api/src/db/migrations/`, named `<timestamp>_<name>.sql`, each with `-- migrate:up` and `-- migrate:down` sections.
- Scripts:
  - `npm run db:migrate` applies pending migrations.
  - `npm run db:status` lists them.
  - `npm run db:new -- <name>` creates a new file.
- The tests' global setup (`apps/api/src/testing/global-setup.ts`) migrates the test database before every run.
- `--no-dump-schema` is set because dbmate's schema dump needs `pg_dump`, which isn't installed on Windows.

### Roles: `apps/api/src/db/roles.sql`

| Role             | Used by                                         | Rights                                                                       |
| ---------------- | ----------------------------------------------- | ---------------------------------------------------------------------------- |
| `callmate`       | Docker/CI admin only, to create the others      | Superuser (local and CI only)                                                |
| `callmate_owner` | `npm run db:migrate` (`MIGRATION_DATABASE_URL`) | Owns the database and every table. Not a superuser                           |
| `callmate_app`   | The API (`DATABASE_URL`)                        | Only what migrations `GRANT` it. Not an owner, not a superuser, no BYPASSRLS |

- Roles are environment setup, not migrations. Locally, Docker runs `roles.sql` when each database is first created. CI pipes it into the service container. Step 8 creates Azure's roles without passwords in the repo.
- The API never holds the owner's credentials, so even a fully compromised API can't alter tables or disable row-level security.
- Each table's grants are written explicitly in its migration, with no blanket default privileges. For example, `callmate_app` can read `system_settings` but not change it.

## Options considered

1. **dbmate (chosen).**
   - Each migration runs inside a transaction, so a failure leaves nothing half-applied.
   - The npm package ships prebuilt binaries for Windows and Linux; the lockfile records both, and this was tested on Linux.
   - It has a built-in `status` command and needs no Node code.
2. **postgrator.**
   - Discarded: it's a small library on top of `pg`, but its docs say migrations are **not** wrapped in a transaction unless you add `BEGIN`/`COMMIT` yourself. We'd also need to write our own CLI.
3. **node-pg-migrate.**
   - Discarded: it's primarily a JavaScript migration API (`pgm.createTable`), which goes against the plan's plain SQL.
4. **Graphile Migrate.**
   - Discarded: strong, but its `current.sql` development workflow is a lot to learn for a team of one.
5. **A hand-written runner.**
   - Discarded: it's about 50 lines until you need locking, checksums and status, and then it's reinventing dbmate.

**Confidence:** high for dbmate. Medium for the roles bootstrap: Step 8 might find Azure needs a different mechanism, such as Entra ID authentication for the app role.

**Strongest case against:** dbmate is a Go binary inside an npm package, so its install relies on npm picking the right platform package. If that ever breaks (as it has for some tools), migrations and tests fail to start until it's fixed.

## Gotchas

- **dbmate requires SSL by default.** Local Docker and CI have none, so their migration URLs end `?sslmode=disable`. Azure will require SSL, so leave the default there.
- **dbmate reads `.env` itself** (from the current folder). `--env MIGRATION_DATABASE_URL` stops it from using the app's `DATABASE_URL` by mistake.
- **Docker's init scripts run only when a data directory is created.** After editing `roles.sql`, recreate the dev database with `docker compose down -v` (this wipes dev data). The test database is in memory, so it's recreated on every `npm run db:up` after a stop.
- **Step 8 needs dbmate in the deploy job.** It's currently a dev dependency, so either the job installs dev dependencies or dbmate moves to `dependencies`.
