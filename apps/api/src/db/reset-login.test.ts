import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import { claimAccountByEmail, findAccountBySubject } from "./accounts.ts";
import { createAdminPool, createUser, resetLogin } from "./cross-tenant.ts";
import { createPool } from "./pool.ts";

const pool = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);

afterAll(async () => {
  await Promise.all([pool.end(), admin.end()]);
});

describe("resetLogin", () => {
  it("lets a claimed account be claimed again by its email, by a new login", async () => {
    const email = `Reset-${randomUUID()}@example.com`;
    const oldSubject = `sub_${randomUUID()}`;
    await createUser(admin, { authSubject: oldSubject, email, role: "admin" });
    expect(await findAccountBySubject(pool, oldSubject)).toMatchObject({ role: "admin" });

    // Claimed already, so a new login with the same email gets nothing...
    const newSubject = `sub_${randomUUID()}`;
    expect(await claimAccountByEmail(pool, newSubject, email.toLowerCase())).toBeNull();

    // ...until the login is reset: then the new login takes it and the old one is out.
    expect(await resetLogin(admin, email.toLowerCase())).toBe(true);
    expect(await claimAccountByEmail(pool, newSubject, email)).toMatchObject({ role: "admin" });
    expect(await findAccountBySubject(pool, newSubject)).toMatchObject({ email, role: "admin" });
    expect(await findAccountBySubject(pool, oldSubject)).toBeNull();
  });

  it("says when there's nothing to reset", async () => {
    expect(await resetLogin(admin, `nobody-${randomUUID()}@example.com`)).toBe(false);
  });
});
