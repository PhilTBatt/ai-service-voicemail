// The tenant context must last one transaction and never outlive it (CLAUDE.md: "tenant
// context is set per transaction, never per connection"). tenancy.test.ts checks the happy
// path on a pooled connection; this file checks the ways a context could leak: after the work
// throws, after a SQL error aborts the transaction, after the work commits early, when the
// connection itself dies, and when many businesses' requests share a small pool at once. It
// also checks the database's own guard rails (who may run the lookup functions, which policies
// reach which roles) and that no source file ever sets the context for a whole connection.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createAdminPool } from "./cross-tenant.ts";
import { createPool } from "./pool.ts";
import { withTenant } from "./tenant.ts";
import {
  TEST_ADMIN_DATABASE_URL,
  TEST_DATABASE_URL,
  TEST_MIGRATION_DATABASE_URL,
} from "../testing/databases.ts";
import { createTenantWithData } from "../testing/fixtures.ts";

const app = createPool(TEST_DATABASE_URL);
const owner = createPool(TEST_MIGRATION_DATABASE_URL.replace("?sslmode=disable", ""));

let a: { tenantId: string; callId: string };
let b: { tenantId: string; callId: string };

beforeAll(async () => {
  a = await createTenantWithData(owner, "Leak Test A Plumbing");
  b = await createTenantWithData(owner, "Leak Test B Electrics");
});

afterAll(async () => {
  await Promise.all([app.end(), owner.end()]);
});

/** A pool of exactly one connection: every use below reuses the same one. */
function singleConnectionPool(): pg.Pool {
  const pool = createPool(TEST_DATABASE_URL);
  pool.options.max = 1;
  return pool;
}

/** What a plain query on the pool sees, outside any withTenant: the leak, if there is one. */
async function seenWithoutTenant(pool: pg.Pool) {
  const tenants = await pool.query<{ id: string }>("SELECT id FROM tenants");
  const setting = await pool.query<{ value: string | null }>(
    "SELECT current_setting('app.tenant_id', true) AS value",
  );
  return { tenants: tenants.rows.map((row) => row.id), setting: setting.rows[0]!.value || null };
}

const tenantsSeen = (client: pg.PoolClient) =>
  client.query<{ id: string }>("SELECT id FROM tenants").then((r) => r.rows.map((row) => row.id));

describe("withTenant never leaves a business's context on the connection", () => {
  it("after the work throws", async () => {
    const pool = singleConnectionPool();
    try {
      await expect(
        withTenant(pool, a.tenantId, () => Promise.reject(new Error("work failed"))),
      ).rejects.toThrow("work failed");
      expect(await seenWithoutTenant(pool)).toEqual({ tenants: [], setting: null });
      // And the next business on the same connection sees only itself.
      expect(await withTenant(pool, b.tenantId, tenantsSeen)).toEqual([b.tenantId]);
    } finally {
      await pool.end();
    }
  });

  it("after a SQL error aborts the transaction", async () => {
    const pool = singleConnectionPool();
    try {
      await expect(
        withTenant(pool, a.tenantId, (client) => client.query("SELECT 1/0")),
      ).rejects.toMatchObject({ code: "22012" });
      expect(await seenWithoutTenant(pool)).toEqual({ tenants: [], setting: null });
      expect(await withTenant(pool, b.tenantId, tenantsSeen)).toEqual([b.tenantId]);
    } finally {
      await pool.end();
    }
  });

  it("after the work swallows a SQL error and carries on", async () => {
    // The transaction is aborted; anything more the work tries fails, and nothing is written.
    const pool = singleConnectionPool();
    const providerCallId = `call_${randomUUID()}`;
    try {
      await withTenant(pool, a.tenantId, async (client) => {
        await client.query("SELECT 1/0").catch(() => undefined);
        await client
          .query(
            "INSERT INTO calls (tenant_id, provider_call_id, started_at) VALUES ($1, $2, now())",
            [a.tenantId, providerCallId],
          )
          .catch(() => undefined);
      });
      const found = await withTenant(pool, a.tenantId, (client) =>
        client.query("SELECT 1 FROM calls WHERE provider_call_id = $1", [providerCallId]),
      );
      expect(found.rowCount).toBe(0);
      expect(await seenWithoutTenant(pool)).toEqual({ tenants: [], setting: null });
    } finally {
      await pool.end();
    }
  });

  it("after the work commits early: what follows runs with no business at all", async () => {
    // A COMMIT inside the work ends the transaction and the context with it, so the rest of
    // the work sees nothing: a mistake there narrows what it sees, never widens it.
    const pool = singleConnectionPool();
    try {
      const afterCommit = await withTenant(pool, a.tenantId, async (client) => {
        await client.query("COMMIT");
        return tenantsSeen(client);
      });
      expect(afterCommit).toEqual([]);
      expect(await seenWithoutTenant(pool)).toEqual({ tenants: [], setting: null });
    } finally {
      await pool.end();
    }
  });

  it("after the connection dies mid-transaction: it's thrown away, and the pool carries on", async () => {
    // The database restarting under a request. A dead connection also emits an 'error' event;
    // unheard, Node stops the whole process (Vitest reports it as an unhandled error).
    const pool = singleConnectionPool();
    try {
      await expect(
        withTenant(pool, a.tenantId, async (client) => {
          await client.query("SELECT pg_terminate_backend(pg_backend_pid())").catch(() => {});
          // Give the connection's end its turn, while it's still checked out.
          await new Promise((resolve) => setTimeout(resolve, 50));
          await client.query("SELECT 1");
        }),
      ).rejects.toThrow();
      expect(await withTenant(pool, b.tenantId, tenantsSeen)).toEqual([b.tenantId]);
      expect(await seenWithoutTenant(pool)).toEqual({ tenants: [], setting: null });
    } finally {
      await pool.end();
    }
  });

  it("keeps the admin pool's process up when a connection it lent out dies", async () => {
    // The admin functions hold a connection through a transaction (deleting a business's
    // data, signing one up). Its death must fail that work, not the whole process: Vitest
    // reports an unheard 'error' event as an unhandled error, failing the run.
    const adminPool = createAdminPool(TEST_ADMIN_DATABASE_URL, { max: 1 });
    try {
      const client = await adminPool.connect();
      await expect(client.query("SELECT pg_terminate_backend(pg_backend_pid())")).rejects.toThrow();
      // Give the connection's end its turn, when the 'error' event goes out.
      await new Promise((resolve) => setTimeout(resolve, 50));
      client.release(true);
      const { rows } = await adminPool.query<{ ok: number }>("SELECT 1 AS ok");
      expect(rows).toEqual([{ ok: 1 }]);
    } finally {
      await adminPool.end();
    }
  });

  it("keeps many businesses apart when their requests interleave on a small pool", async () => {
    const pool = createPool(TEST_DATABASE_URL);
    pool.options.max = 2;
    try {
      const runs = Array.from({ length: 30 }, (_, i) => {
        const tenantId = i % 2 === 0 ? a.tenantId : b.tenantId;
        return withTenant(pool, tenantId, async (client) => {
          // A pause inside the transaction, so the others queue up behind and interleave.
          await client.query("SELECT pg_sleep($1)", [(i % 5) / 1000]);
          const seen = await tenantsSeen(client);
          const calls = await client.query<{ tenant_id: string }>("SELECT tenant_id FROM calls");
          return { tenantId, seen, callTenants: new Set(calls.rows.map((r) => r.tenant_id)) };
        });
      });
      for (const run of await Promise.all(runs)) {
        expect(run.seen).toEqual([run.tenantId]);
        expect(run.callTenants).toEqual(new Set([run.tenantId]));
      }
      expect(await seenWithoutTenant(pool)).toEqual({ tenants: [], setting: null });
    } finally {
      await pool.end();
    }
  });

  it("can't be talked into another business by the work setting the context itself", async () => {
    // set_config inside the work would only last the transaction too. What matters is that a
    // plain query afterwards (the login lookup, the readiness check) sees nothing.
    const pool = singleConnectionPool();
    try {
      const seen = await withTenant(pool, a.tenantId, async (client) => {
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [b.tenantId]);
        return tenantsSeen(client);
      });
      expect(seen).toEqual([b.tenantId]);
      expect(await seenWithoutTenant(pool)).toEqual({ tenants: [], setting: null });
    } finally {
      await pool.end();
    }
  });

  it("refuses a business ID that isn't a UUID before it borrows a connection", async () => {
    const pool = singleConnectionPool();
    try {
      for (const bad of [
        "",
        "not-a-uuid",
        `${a.tenantId}' OR '1'='1`,
        `${a.tenantId}; SET app.tenant_id = '${b.tenantId}'`,
        a.tenantId.replaceAll("-", ""),
        ` ${a.tenantId}`,
      ]) {
        await expect(withTenant(pool, bad, tenantsSeen), JSON.stringify(bad)).rejects.toThrow();
      }
      expect(pool.totalCount).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it("shows nothing for a well-formed ID that no business has", async () => {
    expect(await withTenant(app, randomUUID(), tenantsSeen)).toEqual([]);
  });
});

describe("the database's guard rails", () => {
  it("gives every SECURITY DEFINER function a fixed search_path, and only the app role may run it", async () => {
    // A definer function runs with its owner's rights: without a fixed search_path, a role
    // that could create objects could slip its own table or operator in front of ours.
    const { rows } = await owner.query<{
      name: string;
      config: string[] | null;
      publicCanRun: boolean;
      adminCanRun: boolean;
      appCanRun: boolean;
    }>(`
      SELECT p.proname AS name, p.proconfig AS config,
             has_function_privilege('public', p.oid, 'EXECUTE') AS "publicCanRun",
             has_function_privilege('callmate_admin', p.oid, 'EXECUTE') AS "adminCanRun",
             has_function_privilege('callmate_app', p.oid, 'EXECUTE') AS "appCanRun"
      FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef`);
    expect(rows.length).toBeGreaterThan(0);
    for (const fn of rows) {
      expect(fn.config ?? [], fn.name).toContain("search_path=pg_catalog, pg_temp");
      expect(fn, fn.name).toMatchObject({
        publicCanRun: false,
        adminCanRun: false,
        appCanRun: true,
      });
    }
  });

  it("lets the lookup functions answer with an ID only, never a row of another business", async () => {
    // What each definer function returns: one uuid, the caller's own account, or (for the data
    // export) the email and role of each person with access to the business the transaction is
    // set to, which every-tenant-table.test.ts checks answers for no other business. None
    // returns call data, or anyone's details beyond those.
    const { rows } = await owner.query<{ name: string; result: string }>(`
      SELECT p.proname AS name, pg_get_function_result(p.oid) AS result
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
      ORDER BY 1`);
    for (const fn of rows) {
      if (fn.name.startsWith("tenant_id_for_")) expect(fn.result, fn.name).toBe("uuid");
      else if (fn.name === "tenant_members")
        expect(fn.result, fn.name).toBe(
          "TABLE(email text, role text, added_at timestamp with time zone)",
        );
      else
        expect(fn.result, fn.name).toBe(
          "TABLE(user_id uuid, email text, role text, tenant_id uuid)",
        );
    }
  });

  it("grants nothing on any table to PUBLIC", async () => {
    const { rows } = await owner.query(`
      SELECT table_name, privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND grantee = 'PUBLIC'`);
    expect(rows).toEqual([]);
  });

  it("gives the app role no way into the users table or the signup links", async () => {
    // Logins are looked up through account_for_subject; links only through the admin role.
    const { rows } = await owner.query<{ table: string; any: boolean }>(`
      SELECT t AS table,
             has_table_privilege('callmate_app', t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') AS any
      FROM unnest(ARRAY['users', 'signup_links']) AS t`);
    expect(rows).toEqual([
      { table: "users", any: false },
      { table: "signup_links", any: false },
    ]);
  });

  it("lets no role but the owner delete or truncate a tenant table outside its policies", async () => {
    // TRUNCATE skips row-level security altogether: nobody but the owner may have it.
    const { rows } = await owner.query(`
      SELECT grantee, table_name FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND privilege_type = 'TRUNCATE'
        AND grantee IN ('callmate_app', 'callmate_admin')`);
    expect(rows).toEqual([]);
  });

  it("aims every policy but tenant isolation at one named role: full access only for the admin role, reads only for the owner", async () => {
    const { rows } = await owner.query<{
      table: string;
      policy: string;
      roles: string[];
      cmd: string;
    }>(`
      SELECT tablename AS table, policyname AS policy, roles::text[] AS roles, cmd
      FROM pg_policies WHERE schemaname = 'public' AND policyname <> 'tenant_isolation'`);
    for (const policy of rows) {
      const where = `${policy.table}.${policy.policy}`;
      if (policy.roles.includes("callmate_admin")) {
        expect(policy.roles, where).toEqual(["callmate_admin"]);
      } else {
        // The definer lookups' way in: reading, as the owner, and nothing else.
        expect(policy.roles, where).toEqual(["callmate_owner"]);
        expect(policy.cmd, where).toBe("SELECT");
      }
    }
  });

  it("makes current_tenant_id() read nothing, not fail, once a connection has had a business", async () => {
    // After a transaction with the setting, it reads '' rather than NULL; the function's NULLIF
    // turns that into no business instead of an invalid-uuid error on every later query.
    const pool = singleConnectionPool();
    try {
      await withTenant(pool, a.tenantId, tenantsSeen);
      const { rows } = await pool.query<{ id: string | null }>("SELECT current_tenant_id() AS id");
      expect(rows[0]!.id).toBeNull();
    } finally {
      await pool.end();
    }
  });
});

describe("the source code", () => {
  const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return name === "testing" ? [] : sourceFiles(full);
      return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : [];
    });
  }

  it("only ever sets the business for one transaction, never for a whole connection", () => {
    // A session-wide SET would follow the pooled connection into the next request, which
    // could be another business's (the bug withTenant exists to prevent).
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      if (/\bSET\s+(SESSION\s+)?app\.tenant_id\b/i.test(text)) offenders.push(`${file}: SET`);
      for (const match of text.matchAll(/set_config\(\s*'app\.tenant_id'\s*,[^)]*\)/gi)) {
        if (!/,\s*true\s*\)$/i.test(match[0])) offenders.push(`${file}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
