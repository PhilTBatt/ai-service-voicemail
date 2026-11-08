// An owner's own businesses, for the dashboard's list (BUILD_PLAN Step 10). Each is read inside
// its own row-level-security context (withTenant), where the database shows that business's
// rows and no other's, so the list can't include anyone else's whatever the code above does.
// It used to read every business and every call through the admin pool and filter in code:
// a slip there would have shown other businesses' names, and each owner's page load counted
// the whole calls table. The admin and the reseller see every business, through the
// cross-tenant module (listTenantsWithCallCounts).
import type pg from "pg";
import type { TenantWithCallCounts } from "./cross-tenant.ts";
import { withTenant } from "./tenant.ts";

export async function ownTenantWithCallCounts(
  pool: pg.Pool,
  tenantId: string,
): Promise<TenantWithCallCounts | null> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query<TenantWithCallCounts>(
      `SELECT t.id, t.business_name AS "businessName", t.trade, t.status,
              t.onboarding_state AS "onboardingState", t.created_at AS "createdAt",
              (SELECT count(*) FROM calls c
                WHERE c.tenant_id = t.id AND c.started_at >= now() - interval '30 days')::int
                AS "callsLast30Days",
              (SELECT count(*) FROM calls c WHERE c.tenant_id = t.id)::int AS "callsTotal"
       FROM tenants t WHERE t.id = $1`,
      [tenantId],
    );
    return rows[0] ?? null;
  });
}

/** The owner's businesses, oldest first, as the admin's list orders them. Any that's gone is left out. */
export async function listOwnTenants(
  pool: pg.Pool,
  tenantIds: readonly string[],
): Promise<TenantWithCallCounts[]> {
  const found = await Promise.all(tenantIds.map((id) => ownTenantWithCallCounts(pool, id)));
  return found
    .filter((tenant): tenant is TenantWithCallCounts => tenant !== null)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}
