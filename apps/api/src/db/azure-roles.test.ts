import type pg from "pg";
import { describe, expect, it } from "vitest";
import { fingerprint, passwordIn, roleLoginsFrom, setUpRoles } from "./azure-roles.ts";

const password = "a".repeat(30);
const host = "psql-example.postgres.database.azure.com:5432/callmate?sslmode=require";
const urls = {
  MIGRATION_DATABASE_URL: `postgres://callmate_owner:${password}@${host}`,
  DATABASE_URL: `postgres://callmate_app:${password}@${host}`,
  ADMIN_DATABASE_URL: `postgres://callmate_admin:${password}@${host}`,
};

describe("roleLoginsFrom", () => {
  it("takes each login's password from the URL it's used with", () => {
    expect(roleLoginsFrom(urls)).toEqual([
      { role: "callmate_owner", password },
      { role: "callmate_app", password },
      { role: "callmate_admin", password },
    ]);
  });

  it("decodes a password that had to be escaped in the URL", () => {
    const tricky = `${"b".repeat(26)}/:@x`;
    const logins = roleLoginsFrom({
      ...urls,
      DATABASE_URL: `postgres://callmate_app:${encodeURIComponent(tricky)}@${host}`,
    });
    expect(logins[1]).toEqual({ role: "callmate_app", password: tricky });
  });

  it.each([
    ["a missing URL", { DATABASE_URL: undefined }, /DATABASE_URL is missing/],
    ["something that isn't a URL", { DATABASE_URL: "not a url" }, /isn't a URL/],
    [
      "the wrong login",
      { ADMIN_DATABASE_URL: `postgres://callmate_app:${password}@${host}` },
      /should log in as callmate_admin/,
    ],
    [
      "a short password",
      { MIGRATION_DATABASE_URL: `postgres://callmate_owner:short@${host}` },
      /at least 24 characters/,
    ],
  ])("refuses %s", (_label, change, error) => {
    expect(() => roleLoginsFrom({ ...urls, ...change })).toThrow(error);
  });
});

/**
 * A stand-in for the admin's connection that records each statement and answers the few
 * queries setUpRoles reads from. The real thing was run against a simulated Azure database
 * (the public schema owned by another role) when this was written; see PROGRESS 2026-11-10.
 */
function stubClient(publicSchema: { grantable: boolean }) {
  const statements: string[] = [];
  const client = {
    escapeIdentifier: (name: string) => `"${name}"`,
    escapeLiteral: (value: string) => `'${value}'`,
    query: (sql: string) => {
      statements.push(sql);
      if (sql.startsWith("SELECT 1 FROM pg_roles"))
        return Promise.resolve({ rowCount: 0, rows: [] });
      if (sql.startsWith("SELECT current_database()")) {
        return Promise.resolve({ rowCount: 1, rows: [{ db: "callmate" }] });
      }
      if (sql.includes("has_schema_privilege")) {
        return Promise.resolve({
          rowCount: 4,
          rows: [
            { role: "callmate_owner", ok: publicSchema.grantable },
            { role: "callmate_owner", ok: publicSchema.grantable },
            { role: "callmate_app", ok: true },
            { role: "callmate_admin", ok: true },
          ],
        });
      }
      if (sql.includes("nspowner")) {
        return Promise.resolve({ rowCount: 1, rows: [{ owner: "azure_pg_admin" }] });
      }
      return Promise.resolve({ rowCount: 0, rows: [] });
    },
  };
  return { client: client as unknown as pg.ClientBase, statements };
}

describe("setUpRoles", () => {
  it("creates the logins, hands the database and the public schema to the owner, and checks", async () => {
    const { client, statements } = stubClient({ grantable: true });
    await setUpRoles(client, roleLoginsFrom(urls));
    expect(statements).toEqual(
      expect.arrayContaining([
        `CREATE ROLE "callmate_owner" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${password}'`,
        "GRANT callmate_app TO callmate_owner",
        "GRANT callmate_owner TO CURRENT_USER",
        'ALTER DATABASE "callmate" OWNER TO callmate_owner',
        "GRANT USAGE, CREATE ON SCHEMA public TO callmate_owner",
        "GRANT USAGE ON SCHEMA public TO callmate_app, callmate_admin",
      ]),
    );
    expect(statements.filter((sql) => sql.startsWith("CREATE ROLE"))).toHaveLength(3);
  });

  it("fails loudly when the grant on public didn't take, naming the schema's owner", async () => {
    const { client } = stubClient({ grantable: false });
    await expect(setUpRoles(client, roleLoginsFrom(urls))).rejects.toThrow(
      /callmate_owner can't use the public schema.*owner is azure_pg_admin/,
    );
  });
});

describe("fingerprint", () => {
  it("is 8 hex digits, the same for the same secret and different for a different one", () => {
    expect(fingerprint(password)).toMatch(/^[0-9a-f]{8}$/);
    expect(fingerprint(password)).toBe(fingerprint(password));
    expect(fingerprint(password)).not.toBe(fingerprint(`${password}x`));
  });

  it("matches what the Deploy workflow prints with sha256sum", () => {
    // echo -n "secret" | sha256sum | cut -c1-8
    expect(fingerprint("secret")).toBe("2bb80d53");
  });
});

describe("passwordIn", () => {
  it("decodes the password a URL had to escape", () => {
    expect(passwordIn(`postgres://callmateadmin:${encodeURIComponent("p@ss/w:rd")}@${host}`)).toBe(
      "p@ss/w:rd",
    );
  });

  it("refuses something that isn't a URL", () => {
    expect(() => passwordIn("not a url")).toThrow(/isn't a URL/);
  });
});
