import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startQueue } from "../jobs/queue.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import { activeNumberFor, createAdminPool, tenantExists } from "./cross-tenant.ts";
import { createDemoBusiness } from "./demo-business.ts";
import { createPool } from "./pool.ts";
import { SEED_TENANTS } from "./seed.ts";

const pool = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);
let boss: PgBoss;

beforeAll(async () => {
  boss = await startQueue(TEST_DATABASE_URL);
});

afterAll(async () => {
  await boss.stop({ graceful: false, close: true });
  await Promise.all([pool.end(), admin.end()]);
});

const demo = SEED_TENANTS[0]!;
// The seed's own number: other tests may have seeded the demo business into this database
// already, and a second active number is exactly what the function refuses to add.
const input = {
  mobile: "+447700900910",
  email: "demo-owner@example.com",
  number: demo.phoneNumber,
  providerSid: demo.providerSid,
};

describe("createDemoBusiness", () => {
  it("sets up the seed's demo tenant, its number and a synced-to-be profile, and is safe to repeat", async () => {
    const existed = await tenantExists(admin, demo.id);
    const hadNumber = (await activeNumberFor(admin, demo.id))?.number === demo.phoneNumber;

    const first = await createDemoBusiness({ admin, pool, boss }, input);
    expect(first).toMatchObject({
      tenantId: demo.id,
      created: !existed,
      numberRecorded: !hadNumber,
    });
    expect(await tenantExists(admin, demo.id)).toBe(true);
    expect(await activeNumberFor(admin, demo.id)).toEqual({
      number: demo.phoneNumber,
      providerSid: demo.providerSid,
    });
    const { rows } = await admin.query<{ status: string; business_name: string }>(
      "SELECT status, business_name FROM tenants WHERE id = $1",
      [demo.id],
    );
    expect(rows[0]).toEqual({ status: "demo", business_name: demo.businessName });

    const second = await createDemoBusiness({ admin, pool, boss }, input);
    expect(second).toEqual({
      tenantId: demo.id,
      created: false,
      numberRecorded: false,
      profileVersion: first.profileVersion + 1,
    });
  });

  it("refuses to give the demo business a second number", async () => {
    await createDemoBusiness({ admin, pool, boss }, input);
    await expect(
      createDemoBusiness(
        { admin, pool, boss },
        { ...input, number: "+441632960991", providerSid: "PN_ANOTHER" },
      ),
    ).rejects.toThrow(/already has a different active number/);
  });
});
