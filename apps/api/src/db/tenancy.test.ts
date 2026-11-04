import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL, TEST_MIGRATION_DATABASE_URL } from "../testing/databases.ts";
import { createTenantWithData } from "../testing/fixtures.ts";
import { createPool } from "./pool.ts";
import { withTenant } from "./tenant.ts";

// The API's connection (app role) and the migration owner's, both on the test database.
const app = createPool(TEST_DATABASE_URL);
const owner = createPool(TEST_MIGRATION_DATABASE_URL.replace("?sslmode=disable", ""));

let a: { tenantId: string; callId: string };
let b: { tenantId: string; callId: string };

beforeAll(async () => {
  a = await createTenantWithData(owner, "Tenant A Plumbing");
  b = await createTenantWithData(owner, "Tenant B Electrics");
});

afterAll(async () => {
  await Promise.all([app.end(), owner.end()]);
});

describe("row-level security", () => {
  it("is enabled and forced, with a policy, on every table that has tenant data", async () => {
    // Any table with a tenant_id column (plus tenants itself) must be protected. This also
    // catches future tables that forget to turn RLS on.
    const { rows } = await app.query<{
      name: string;
      enabled: boolean;
      forced: boolean;
      isolated: boolean;
    }>(`
      SELECT c.relname AS name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
             EXISTS (SELECT 1 FROM pg_policy p
                     WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS isolated
      FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
        AND (c.relname = 'tenants' OR EXISTS (
          SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped))
      ORDER BY c.relname`);
    expect(rows.length).toBeGreaterThanOrEqual(11);
    for (const table of rows) {
      expect(table, table.name).toMatchObject({ enabled: true, forced: true, isolated: true });
    }
  });

  it("applies no policy to the app role except tenant isolation", async () => {
    // Policies are OR'd together, so one stray "USING (true)" reaching the app role would
    // open a whole table. Policies for PUBLIC apply to every role, including the app role.
    const { rows } = await app.query<{ table: string; policy: string }>(`
      SELECT tablename AS table, policyname AS policy FROM pg_policies
      WHERE schemaname = 'public' AND policyname <> 'tenant_isolation'
        AND (roles && ARRAY['public', 'callmate_app']::name[])`);
    expect(rows).toEqual([]);
  });

  it("lets a tenant see only its own rows", async () => {
    const calls = await withTenant(app, a.tenantId, async (client) => {
      const { rows } = await client.query<{ id: string }>("SELECT id FROM calls");
      return rows.map((row) => row.id);
    });
    expect(calls).toEqual([a.callId]);

    const tenants = await withTenant(app, a.tenantId, async (client) => {
      const { rows } = await client.query<{ id: string }>("SELECT id FROM tenants");
      return rows.map((row) => row.id);
    });
    expect(tenants).toEqual([a.tenantId]);
  });

  it("stops a tenant updating another tenant's rows", async () => {
    const updated = await withTenant(app, a.tenantId, async (client) => {
      const result = await client.query("UPDATE calls SET summary = 'hacked' WHERE id = $1", [
        b.callId,
      ]);
      return result.rowCount;
    });
    expect(updated).toBe(0);

    const summary = await withTenant(app, b.tenantId, async (client) => {
      const { rows } = await client.query("SELECT summary FROM calls WHERE id = $1", [b.callId]);
      return rows[0] as unknown;
    });
    expect(summary).toEqual({ summary: null });
  });

  it("stops a tenant deleting another tenant's rows", async () => {
    const deleted = await withTenant(app, a.tenantId, async (client) => {
      const result = await client.query("DELETE FROM blocked_numbers WHERE tenant_id = $1", [
        b.tenantId,
      ]);
      return result.rowCount;
    });
    expect(deleted).toBe(0);

    const remaining = await withTenant(app, b.tenantId, async (client) => {
      const { rows } = await client.query("SELECT count(*)::int AS n FROM blocked_numbers");
      return rows[0] as unknown;
    });
    expect(remaining).toEqual({ n: 1 });
  });

  it("stops a tenant writing rows for another tenant", async () => {
    await expect(
      withTenant(app, a.tenantId, (client) =>
        client.query(
          "INSERT INTO calls (tenant_id, provider_call_id, started_at) VALUES ($1, $2, now())",
          [b.tenantId, `call_${randomUUID()}`],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("stops a tenant's row pointing at another tenant's call", async () => {
    // Tenant A's notification for tenant B's call: RLS allows the row (it's A's), but the
    // (tenant_id, call_id) foreign key finds no call with that pair.
    await expect(
      withTenant(app, a.tenantId, (client) =>
        client.query(
          "INSERT INTO notifications (tenant_id, call_id, channel) VALUES ($1, $2, 'sms')",
          [a.tenantId, b.callId],
        ),
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it("returns no rows when no tenant is set", async () => {
    const { rows } = await app.query("SELECT id FROM calls");
    expect(rows).toEqual([]);
    const tenants = await app.query("SELECT id FROM tenants");
    expect(tenants.rows).toEqual([]);
  });
});

describe("withTenant", () => {
  it("doesn't leak the tenant into the next use of a pooled connection", async () => {
    // A pool of one connection, so every call below reuses the same connection.
    const single = createPool(TEST_DATABASE_URL);
    single.options.max = 1;
    try {
      const firstSees = await withTenant(single, a.tenantId, async (client) => {
        const { rows } = await client.query<{ id: string }>("SELECT id FROM tenants");
        return rows.map((row) => row.id);
      });
      const secondSees = await withTenant(single, b.tenantId, async (client) => {
        const { rows } = await client.query<{ id: string }>("SELECT id FROM tenants");
        return rows.map((row) => row.id);
      });
      expect(firstSees).toEqual([a.tenantId]);
      expect(secondSees).toEqual([b.tenantId]);

      // Same connection, outside withTenant: the setting is gone, so nothing is visible
      // (and no error, despite the setting now reading as '' rather than NULL).
      const afterwards = await single.query("SELECT id FROM tenants");
      expect(afterwards.rows).toEqual([]);
    } finally {
      await single.end();
    }
  });

  it("rolls back everything if the function throws", async () => {
    const providerCallId = `call_${randomUUID()}`;
    await expect(
      withTenant(app, a.tenantId, async (client) => {
        await client.query(
          "INSERT INTO calls (tenant_id, provider_call_id, started_at) VALUES ($1, $2, now())",
          [a.tenantId, providerCallId],
        );
        throw new Error("something failed after the insert");
      }),
    ).rejects.toThrow("something failed after the insert");

    const found = await withTenant(app, a.tenantId, (client) =>
      client.query("SELECT 1 FROM calls WHERE provider_call_id = $1", [providerCallId]),
    );
    expect(found.rowCount).toBe(0);
  });

  it("rejects a tenant ID that isn't a UUID", async () => {
    await expect(withTenant(app, "not-a-uuid", () => Promise.resolve())).rejects.toThrow();
  });
});

describe("calls", () => {
  it("rejects a duplicate provider_call_id, even from another tenant", async () => {
    const providerCallId = `call_${randomUUID()}`;
    const insert = (tenantId: string) =>
      withTenant(app, tenantId, (client) =>
        client.query(
          "INSERT INTO calls (tenant_id, provider_call_id, started_at) VALUES ($1, $2, now())",
          [tenantId, providerCallId],
        ),
      );
    await insert(a.tenantId);
    await expect(insert(a.tenantId)).rejects.toMatchObject({ code: "23505" });
    await expect(insert(b.tenantId)).rejects.toMatchObject({ code: "23505" });
  });
});
