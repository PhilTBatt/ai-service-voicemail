# 002: Postgres driver

- **Date:** 2026-11-04
- **Status:** accepted

## Context

The API needs a PostgreSQL client now, for `/readyz`. Later steps put specific demands on it:

- **Step 1:** `withTenant()` runs `set_config('app.tenant_id', $1, true)` inside a transaction.
- **Step 1:** plain SQL migrations.
- **Step 5:** inserting a call row and enqueueing its pg-boss job must happen in **one transaction**.

## Decision

Use [`pg` (node-postgres)](https://node-postgres.com/) with a single `pg.Pool` per process, created in `apps/api/src/db.ts`.

- `connectionTimeoutMillis: 2000`. pg's default is to wait forever, which would hang requests and readiness checks when the database is unreachable.
- A `pool.on("error")` listener. pg's docs warn that idle connections emit errors when the database restarts, and without a listener that crashes the process. This was verified on 2026-11-04 by stopping the database under a running server.

## Options considered

1. **`pg` (chosen).** pg-boss is built on it, which keeps Step 5's single transaction simple. It's the most widely used Node Postgres driver.
2. **`postgres` (postgres.js).**
   - Discarded: it's faster and has a nicer tagged-template API, but it's a different driver from the one pg-boss uses.
   - Sharing one transaction between two drivers is awkward. My understanding is that it's not possible without an adapter; to be confirmed in Step 5 against pg-boss's docs.
3. **A query builder or ORM (Kysely, Drizzle).**
   - Discarded: BUILD_PLAN asks for plain SQL. Either could be layered on top of `pg` later if the SQL gets repetitive.

**Confidence:** high.

**Strongest case against:** pg's API is older and loosely typed (query results are `any`-shaped unless we add types ourselves). Every query result will need a zod schema or an explicit type at the boundary.
