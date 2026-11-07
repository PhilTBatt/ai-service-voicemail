import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import {
  assignPhoneNumber,
  createAdminPool,
  createTenant,
  estimateCosts,
  findTenantIdByNumber,
  listTenants,
} from "./cross-tenant.ts";
import { createPool } from "./pool.ts";
import { seedDevelopmentData } from "./seed.ts";

const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);

// A unique number from Ofcom's drama range (07700 900000 to 900999) per test run.
function dramaNumber(): string {
  return `+447700900${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
}

let tenantA: string;
let tenantB: string;
let numberA: string;

beforeAll(async () => {
  // Every run starts from an empty database, so the seed tenants this file checks must be put
  // there first (the seed is idempotent: fixed IDs).
  await seedDevelopmentData(admin);
  tenantA = await createTenant(admin, { businessName: "Lookup Plumbing", trade: "plumber" });
  tenantB = await createTenant(admin, { businessName: "Lookup Electrics", trade: "electrician" });
  // Drama numbers are reused across test runs, so free this one up first.
  numberA = dramaNumber();
  await admin.query(
    "UPDATE phone_numbers SET status = 'released', released_at = now() WHERE number = $1 AND status = 'active'",
    [numberA],
  );
  await assignPhoneNumber(admin, tenantA, numberA, `PN${randomUUID()}`);
});

afterAll(async () => {
  await Promise.all([app.end(), admin.end()]);
});

describe("findTenantIdByNumber (webhook lookup, as the app role)", () => {
  it("finds the tenant that owns an active number", async () => {
    expect(await findTenantIdByNumber(app, numberA)).toBe(tenantA);
  });

  it("returns null for a number nobody owns", async () => {
    expect(await findTenantIdByNumber(app, "+441632960999")).toBeNull();
  });

  it("ignores released numbers", async () => {
    const number = "+441134960" + String(Math.floor(Math.random() * 1000)).padStart(3, "0");
    await admin.query(
      "UPDATE phone_numbers SET status = 'released', released_at = now() WHERE number = $1 AND status = 'active'",
      [number],
    );
    await assignPhoneNumber(admin, tenantB, number, `PN${randomUUID()}`);
    await admin.query(
      "UPDATE phone_numbers SET status = 'released', released_at = now() WHERE number = $1",
      [number],
    );
    expect(await findTenantIdByNumber(app, number)).toBeNull();
  });

  it("returns only an ID", async () => {
    const { rows, fields } = await app.query("SELECT * FROM tenant_id_for_number($1)", [numberA]);
    expect(fields.map((field) => field.name)).toEqual(["tenant_id_for_number"]);
    expect(rows).toEqual([{ tenant_id_for_number: tenantA }]);

    const { rows: definition } = await app.query(`
      SELECT prorettype::regtype::text AS returns, proretset AS returns_set,
             prosecdef AS security_definer, proconfig AS settings
      FROM pg_proc WHERE proname = 'tenant_id_for_number'`);
    expect(definition).toEqual([
      {
        returns: "uuid",
        returns_set: false,
        security_definer: true,
        settings: ["search_path=pg_catalog, pg_temp"],
      },
    ]);
  });

  it("can only be called by the app role", async () => {
    const { rows } = await app.query(`
      SELECT r.rolname, has_function_privilege(r.oid, 'tenant_id_for_number(text)', 'EXECUTE') AS can_call
      FROM pg_roles r WHERE r.rolname IN ('callmate_app', 'callmate_admin') ORDER BY r.rolname`);
    expect(rows).toEqual([
      { rolname: "callmate_admin", can_call: false },
      { rolname: "callmate_app", can_call: true },
    ]);
  });

  it("doesn't let the app role read phone numbers directly", async () => {
    const { rows } = await app.query("SELECT * FROM phone_numbers");
    expect(rows).toEqual([]);
  });
});

describe("admin pool", () => {
  it("connects as an ordinary role: not a superuser, no BYPASSRLS", async () => {
    const { rows } = await admin.query(
      "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(rows).toEqual([{ rolname: "callmate_admin", rolsuper: false, rolbypassrls: false }]);
  });

  it("sees every tenant, without setting one", async () => {
    const ids = (await listTenants(admin)).map((tenant) => tenant.id);
    expect(ids).toEqual(expect.arrayContaining([tenantA, tenantB]));
  });

  it("can't change the schema", async () => {
    await expect(admin.query("CREATE TABLE sneaky (id int)")).rejects.toThrow(/permission denied/);
    await expect(admin.query("ALTER TABLE calls DISABLE ROW LEVEL SECURITY")).rejects.toThrow(
      /must be owner/,
    );
  });

  it("can't give a tenant a second active number", async () => {
    await expect(
      assignPhoneNumber(admin, tenantA, dramaNumber(), `PN${randomUUID()}`),
    ).rejects.toMatchObject({ code: "23505" });
  });
});

describe("estimateCosts", () => {
  it("adds up each tenant's recorded costs at the given prices, rounding to pence once", async () => {
    const tenantId = await createTenant(admin, {
      businessName: "Costly Plumbing",
      trade: "plumber",
    });
    // Ofcom's drama range 01632 960000 to 960999, freed first because runs reuse numbers.
    const number = `+441632960${String(Math.floor(Math.random() * 990)).padStart(3, "0")}`;
    await admin.query(
      "UPDATE phone_numbers SET status = 'released', released_at = now() WHERE number = $1 AND status = 'active'",
      [number],
    );
    await assignPhoneNumber(admin, tenantId, number, `PN${randomUUID()}`);

    const call = async (startedAt: string, seconds: number, viaFallback: boolean) =>
      (
        await admin.query<{ id: string }>(
          `INSERT INTO calls (tenant_id, provider_call_id, started_at, ended_at, via_fallback)
           VALUES ($1, $2, $3, $3::timestamptz + make_interval(secs => $4), $5) RETURNING id`,
          [tenantId, `call_${randomUUID()}`, startedAt, seconds, viaFallback],
        )
      ).rows[0]!.id;
    const cost = (callId: string, component: string, units: number, unitType: string) =>
      admin.query(
        `INSERT INTO call_costs (tenant_id, call_id, component, units, unit_type, is_estimated)
         VALUES ($1, $2, $3, $4, $5, false)`,
        [tenantId, callId, component, units, unitType],
      );

    // A 2:05 call the assistant answered (3 minutes rounded up) and a 0:42 voicemail (1 minute).
    const answered = await call("2031-03-10T10:00:00Z", 125, false);
    const voicemail = await call("2031-03-11T10:00:00Z", 42, true);
    const nextMonth = await call("2031-04-02T10:00:00Z", 600, false);
    await cost(answered, "retell:llm", 33.28, "usd_cents");
    await cost(answered, "retell:voice", 7.8, "usd_cents");
    await cost(answered, "retell:duration", 125, "seconds");
    await cost(answered, "priced-model:input_tokens", 1_000_000, "tokens");
    await cost(answered, "priced-model:output_tokens", 200_000, "tokens");
    await cost(answered, "sms:segments", 2, "segments");
    await cost(voicemail, "mystery:widgets", 3, "widgets");
    await cost(voicemail, "unpriced-model:input_tokens", 500, "tokens");
    await cost(nextMonth, "retell:llm", 1000, "usd_cents");

    const { tenants, unpriced } = await estimateCosts(
      admin,
      { from: new Date("2031-03-01T00:00:00Z"), to: new Date("2031-04-01T00:00:00Z") },
      {
        gbpPerUsd: "0.8",
        smsSegmentGbp: "0.042325",
        inboundCallPerMinuteGbp: "0.007558",
        sipPerMinuteUsd: "0.004",
        localNumberPerMonthGbp: "0.86917",
        models: { "priced-model": { input: 0.1, output: 0.5 } },
      },
    );
    expect(tenants.find((row) => row.tenantId === tenantId)).toEqual({
      tenantId,
      businessName: "Costly Plumbing",
      status: "onboarding",
      calls: 2,
      pence: {
        // (33.28 + 7.8) US cents at 0.8 = 32.864p
        voicePlatform: 33,
        // (1,000,000 x $0.10 + 200,000 x $0.50) per million = $0.20, at 0.8 = 16p
        languageModel: 16,
        // 2 x £0.042325 = 8.465p
        texts: 8,
        // 4 incoming minutes x £0.007558 + 3 SIP minutes x $0.004 at 0.8 = 3.9832p
        phoneMinutes: 4,
        // £0.86917 a month
        number: 87,
        total: 148,
      },
    });
    expect(unpriced).toEqual(["mystery:widgets", "unpriced-model:input_tokens"]);
  });
});
