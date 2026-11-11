// Claiming an invitation at first login (BUILD_PLAN Step 10): an invited account has an email
// and a role but no login yet, and the first login whose VERIFIED email matches takes it. The
// danger is a login taking an account that isn't theirs, or taking two. reset-login.test.ts
// covers resetting a claimed account; this file covers the claim itself under pressure.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import { claimAccountByEmail, findAccountBySubject } from "./accounts.ts";
import { addMembership, createAdminPool, createTenant, inviteUser } from "./cross-tenant.ts";
import { createPool } from "./pool.ts";

const pool = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);

afterAll(async () => {
  await Promise.all([pool.end(), admin.end()]);
});

const subject = () => `sub_${randomUUID()}`;
const email = () => `invited-${randomUUID()}@example.com`;

describe("claiming an invitation", () => {
  it("goes to exactly one login when several with the same address arrive at once", async () => {
    const address = email();
    await inviteUser(admin, { email: address, role: "admin" });
    const logins = Array.from({ length: 6 }, subject);
    const claims = await Promise.all(
      logins.map((login) => claimAccountByEmail(pool, login, address)),
    );
    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    const owners = await Promise.all(logins.map((login) => findAccountBySubject(pool, login)));
    expect(owners.filter((owner) => owner !== null)).toHaveLength(1);
  });

  it("matches the address whatever its capitals, and carries the businesses with it", async () => {
    const address = `Mixed-${randomUUID()}@Example.COM`;
    const invited = await inviteUser(admin, { email: address, role: "owner" });
    const tenantId = await createTenant(admin, {
      businessName: "Claimed Plumbing",
      trade: "plumber",
    });
    await addMembership(admin, tenantId, invited.userId);
    const login = subject();
    expect(await claimAccountByEmail(pool, login, address.toLowerCase())).toEqual({
      userId: invited.userId,
      email: address,
      role: "owner",
      tenantIds: [tenantId],
    });
  });

  it("won't let a login that already has an account take a second one", async () => {
    const login = subject();
    const first = email();
    const second = email();
    await inviteUser(admin, { email: first, role: "owner" });
    await inviteUser(admin, { email: second, role: "admin" });
    expect(await claimAccountByEmail(pool, login, first)).toMatchObject({ role: "owner" });
    // The same login now offering the other address (its email changed at the provider).
    expect(await claimAccountByEmail(pool, login, second)).toBeNull();
    expect(await findAccountBySubject(pool, login)).toMatchObject({ email: first, role: "owner" });
  });

  it("finds nothing for an address that was never invited, or a near miss of one", async () => {
    const address = email();
    await inviteUser(admin, { email: address, role: "admin" });
    for (const near of [
      `${address} `,
      ` ${address}`,
      address.replace("@", "@@"),
      address.replace("invited-", "invited+x-"),
      `${address}.evil.example`,
      "%",
      "_%@%",
      "",
    ]) {
      expect(await claimAccountByEmail(pool, subject(), near), JSON.stringify(near)).toBeNull();
    }
    // Still unclaimed, for the right person.
    expect(await claimAccountByEmail(pool, subject(), address)).toMatchObject({ role: "admin" });
  });

  it("never moves a claimed account to another login", async () => {
    const address = email();
    await inviteUser(admin, { email: address, role: "admin" });
    const first = subject();
    expect(await claimAccountByEmail(pool, first, address)).not.toBeNull();
    expect(await claimAccountByEmail(pool, subject(), address)).toBeNull();
    expect(await findAccountBySubject(pool, first)).toMatchObject({ email: address });
  });

  it("refuses a second invitation for an address that has an account, whatever its capitals", async () => {
    const address = email();
    const invited = await inviteUser(admin, { email: address, role: "owner" });
    expect(await inviteUser(admin, { email: address.toUpperCase(), role: "admin" })).toEqual({
      outcome: "exists",
      role: "owner",
      userId: invited.userId,
    });
  });
});
