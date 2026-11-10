import { describe, expect, it } from "vitest";
import { fingerprint, passwordIn, roleLoginsFrom } from "./azure-roles.ts";

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
