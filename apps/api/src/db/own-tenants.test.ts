import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import { createAdminPool, createTenant } from "./cross-tenant.ts";
import { listOwnTenants, ownTenantWithCallCounts } from "./own-tenants.ts";
import { createPool } from "./pool.ts";

// The app role, as the API reads an owner's list.
const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);

afterAll(async () => {
  await Promise.all([app.end(), admin.end()]);
});

async function addCall(tenantId: string, daysAgo: number) {
  await admin.query(
    `INSERT INTO calls (tenant_id, provider_call_id, started_at)
     VALUES ($1, $2, now() - make_interval(days => $3))`,
    [tenantId, `call_${randomUUID()}`, daysAgo],
  );
}

describe("an owner's own businesses", () => {
  it("counts each business's calls, in the last 30 days and in all", async () => {
    const tenant = await createTenant(admin, { businessName: "Own Plumbing", trade: "plumber" });
    await addCall(tenant, 1);
    await addCall(tenant, 2);
    await addCall(tenant, 45);
    expect(await ownTenantWithCallCounts(app, tenant)).toMatchObject({
      id: tenant,
      businessName: "Own Plumbing",
      trade: "plumber",
      callsLast30Days: 2,
      callsTotal: 3,
    });
  });

  it("lists them oldest first, and leaves out one that's gone", async () => {
    const older = await createTenant(admin, { businessName: "Older Roofing", trade: "roofer" });
    const newer = await createTenant(admin, { businessName: "Newer Locks", trade: "locksmith" });
    await admin.query("UPDATE tenants SET created_at = now() - interval '1 year' WHERE id = $1", [
      older,
    ]);
    const gone = randomUUID();
    const listed = await listOwnTenants(app, [newer, gone, older]);
    expect(listed.map((tenant) => tenant.id)).toEqual([older, newer]);
  });

  it("is empty for an owner with no businesses", async () => {
    expect(await listOwnTenants(app, [])).toEqual([]);
  });
});
