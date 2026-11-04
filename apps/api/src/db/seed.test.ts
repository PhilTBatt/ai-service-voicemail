import { afterAll, describe, expect, it } from "vitest";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import { createAdminPool, findTenantIdByNumber, listTenants } from "./cross-tenant.ts";
import { createPool } from "./pool.ts";
import { SEED_TENANTS, seedDevelopmentData } from "./seed.ts";

const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);
const app = createPool(TEST_DATABASE_URL);

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("seedDevelopmentData", () => {
  it("creates both fictional tenants, and is safe to run again", async () => {
    await seedDevelopmentData(admin);
    expect(await seedDevelopmentData(admin)).toEqual([]); // second run creates nothing

    const seeded = (await listTenants(admin)).filter((tenant) =>
      SEED_TENANTS.some((seed) => seed.id === tenant.id),
    );
    expect(seeded).toEqual([
      { id: SEED_TENANTS[0]!.id, businessName: "Ant's Plumbing", status: "demo" },
      { id: SEED_TENANTS[1]!.id, businessName: "Test Electrics", status: "onboarding" },
    ]);
  });

  it("gives each tenant its drama-range number, findable by the webhook lookup", async () => {
    await seedDevelopmentData(admin);
    for (const seed of SEED_TENANTS) {
      expect(await findTenantIdByNumber(app, seed.phoneNumber)).toBe(seed.id);
    }
  });
});
