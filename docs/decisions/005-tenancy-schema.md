# 005: Tenancy schema and row-level security

- **Date:** 2026-11-04
- **Status:** accepted
- **Migration:** `apps/api/src/db/migrations/20261104200000_create_tenancy_schema.sql`

## Decision

**Isolation.** Every table holding tenant data has a `tenant_id` column, RLS **enabled and forced**, and one policy:

```sql
USING (tenant_id = current_tenant_id())
```

- `current_tenant_id()` reads the transaction-local setting that `withTenant()` sets. It returns NULL when none is set, so every policy matches nothing.
- `tenants` itself uses `id = current_tenant_id()`.
- A test fails if any table with a `tenant_id` column lacks RLS, `FORCE` or a policy, so new tables can't forget it.

**Least-privilege grants.** The app role gets only what the API needs, table by table. For example:

- it can `SELECT` phone numbers but not assign them
- it can only `INSERT` into the audit log
- it has no access to `users` at all

Anything else goes through the admin module (the next change).

## Adjustments to BUILD_PLAN's table list, and why

1. **`tenant_id` on child tables too** (`call_costs`, `notifications`), with a composite foreign key `(tenant_id, call_id) → calls (tenant_id, id)`. The RLS policy then needs no join (simple and fast), and the foreign key makes it impossible for a child row to point at another tenant's call, which is tested.
2. **`users` has no RLS and no app-role access.** People aren't tenant-scoped: admins and resellers span tenants, and one person can belong to several. Step 10 designs auth access to it.
3. **`audit_log.tenant_id` is nullable,** for actions that aren't about one tenant (such as the kill switch). Those rows are invisible in any tenant context.
4. **`text` with `CHECK` constraints instead of Postgres `ENUM` types.** They're easier to change later: altering an enum has restrictions, while a CHECK constraint can simply be replaced.
5. **Agent profile details are `jsonb`** (services, areas, hours, FAQs, emergency policy), validated with zod in the app. Their shape will change as Steps 3 and 11 take shape.
6. **`call_costs` stores units, not money.** Prices are applied from config in Step 5, which avoids rounding fractions of a penny into every row.
7. **Nullable where reality needs it:**
   - `calls.caller_number`, because callers can withhold their number
   - the tenant's notification mobile and email, which are collected during onboarding
8. **Phone numbers are unique only while active** (partial unique indexes), so a released number can be bought again later. There's also one active number per tenant.
9. **`updated_at` is maintained by a trigger,** so no UPDATE statement can forget it.

## Gotchas found and tested

- **`current_setting(..., true)` returns `''`, not NULL, on a connection that has had the setting before.** `''::uuid` is an error, so without `NULLIF`, tenant-less queries on a reused connection would fail instead of returning no rows. A test proved this by removing the `NULLIF`.
- **A plain `SET` leaks the tenant into the next request** on a pooled connection. `withTenant()` uses `set_config(..., true)`, which ends with the transaction. Tested by switching it to a session-wide setting, which made the leak test fail.
- **`FORCE` matters even for us:** test fixtures written as the owner role must set a tenant too.

## Options considered

- **A schema (or database) per tenant.** Discarded: thousands of schemas would make migrations and connection pooling painful, and BUILD_PLAN specifies RLS.
- **Filtering by `tenant_id` in application code only.** Discarded: one forgotten `WHERE` leaks data. RLS makes the database refuse by default.

**Confidence:** high for the RLS design. Medium for individual columns, which later steps will adjust.

**Strongest case against:** RLS hides mistakes as "no rows" rather than errors. A query run without `withTenant()` silently returns nothing, which can look like a bug elsewhere. The tests cover the isolation; developers just need to know that empty results can mean "no tenant set".
