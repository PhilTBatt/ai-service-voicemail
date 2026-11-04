import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import {
  assignPhoneNumber,
  createAdminPool,
  createTenant,
  findTenantIdByNumber,
  listTenants,
} from "./cross-tenant.ts";
import { createPool } from "./pool.ts";

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
