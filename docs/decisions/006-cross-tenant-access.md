# 006: Cross-tenant access

- **Date:** 2026-11-04
- **Status:** accepted
- **Migration:** `apps/api/src/db/migrations/20261104210000_add_cross_tenant_access.sql`
- **Code:** `apps/api/src/db/cross-tenant.ts`, the only module allowed to reach more than one tenant

## Context

Two things need to see across tenants (BUILD_PLAN Step 1):

1. **Webhooks** must find the tenant from the dialled number before any tenant is set.
2. **Admin screens** (and seeding) see every tenant.

The constraint is that tenant-facing code can never reach another tenant's rows, and all cross-tenant code lives in one place, with tests.

RLS is **forced** on every tenant table, so even the table owner sees nothing without a tenant. That rules out the usual "SECURITY DEFINER function owned by the table owner" on its own.

## Decision

**1. Webhook lookup: `tenant_id_for_number(text) → uuid`**

- It's a `SECURITY DEFINER` function owned by `callmate_owner`. A read-only policy, `owner_number_lookup`, lets the owner see `phone_numbers` (and no other table) across tenants.
- It returns **only** the tenant ID: no number, no status, no other columns.
- Hardening, following [the Postgres docs on writing SECURITY DEFINER functions safely](https://www.postgresql.org/docs/16/sql-createfunction.html#SQL-CREATEFUNCTION-SECURITY):
  - `SET search_path = pg_catalog, pg_temp` (temporary schema last, as the docs recommend) and a schema-qualified table name
  - `EXECUTE` revoked from `PUBLIC` and granted to `callmate_app` only
- The app role calls it through `findTenantIdByNumber()`, then uses `withTenant()` with the result.

**2. Admin: a `callmate_admin` login role**

- An `admin_all` policy (`TO callmate_admin USING (true) WITH CHECK (true)`) on every tenant table, plus data grants on all tables.
- It's an ordinary role: not a superuser, no `BYPASSRLS`, owns nothing, so it can't change the schema or switch RLS off.
- Code gets it only through `createAdminPool()`, which returns a **branded** `AdminPool` type. A plain `pg.Pool` doesn't fit that type, so admin functions can't be handed the app's connection by mistake.

**Guards (tests):**

- No policy other than `tenant_isolation` may apply to the app role (or `PUBLIC`).
- Only the app role can call the lookup function.
- The function returns a single `uuid`, is `SECURITY DEFINER` and has a fixed `search_path`.
- The app role still can't read `phone_numbers` directly.

Each of these was checked by breaking it on purpose.

## Options considered

1. **`BYPASSRLS` for the admin role.** Discarded: only a superuser can grant it, and I'm not sure Azure's managed Postgres admin can. Explicit policies work everywhere and show exactly which tables admin reaches.
2. **A function owned by the admin role.** Discarded: changing a function's owner requires that role to have `CREATE` on the schema, which the admin role shouldn't have.
3. **Drop `FORCE` on `phone_numbers`.** Discarded: it weakens the default for the whole table instead of adding one narrow, read-only exception.
4. **Let webhooks use the admin pool.** Discarded: every webhook would then run with access to everything. The function limits webhooks to one fact.

**Confidence:** high.

**Strongest case against:** the owner role can now read all phone numbers outside the function too. It's the migration role, which already owns the tables and could switch RLS off anyway, so this adds little real risk. It's still one more exception to remember.

## Follow-ups

- **Step 4:** the webhook routes use `findTenantIdByNumber()`.
- **Step 10:** admin actions write to `audit_log`. Consider an ESLint `no-restricted-imports` rule so only admin routes can import `cross-tenant.ts`.
- **Step 8:** create `callmate_admin` in Azure, with its credentials in Key Vault.
