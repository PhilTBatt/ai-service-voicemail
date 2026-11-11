// The invite script, run as Phil runs it (as a Deploy task, or npm run invite-user), against the
// test database.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { createAdminPool, createTenant } from "../db/cross-tenant.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";

const run = promisify(execFile);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);
const script = fileURLToPath(new URL("./invite-user.ts", import.meta.url));

afterAll(async () => {
  await admin.end();
});

async function invite(...args: string[]) {
  try {
    const { stdout } = await run(process.execPath, [script, ...args], {
      env: {
        ...process.env,
        NODE_ENV: "test",
        DATABASE_URL: TEST_DATABASE_URL,
        ADMIN_DATABASE_URL: TEST_ADMIN_DATABASE_URL,
      },
    });
    return { code: 0, out: stdout };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, out: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
  }
}

const businessesOf = async (email: string) =>
  (
    await admin.query<{ tenant_id: string }>(
      `SELECT m.tenant_id FROM tenant_memberships m JOIN users u ON u.id = m.user_id
       WHERE lower(u.email) = lower($1) ORDER BY m.tenant_id`,
      [email],
    )
  ).rows.map((row) => row.tenant_id);

describe("invite-user", () => {
  it("gives an owner who already has a business a second one", async () => {
    const email = `two-firms-${randomUUID()}@example.com`;
    const first = await createTenant(admin, { businessName: "First Firm", trade: "plumber" });
    const second = await createTenant(admin, { businessName: "Second Firm", trade: "roofer" });
    expect((await invite("--email", email, "--role", "owner", "--tenant", first)).code).toBe(0);
    const again = await invite("--email", email, "--role", "owner", "--tenant", second);
    expect(again.code).toBe(0);
    expect(again.out).toContain("now has tenant");
    expect(await businessesOf(email)).toEqual([first, second].sort());
  }, 30_000);

  it("creates nobody for a business ID that doesn't exist", async () => {
    const email = `wrong-id-${randomUUID()}@example.com`;
    const result = await invite("--email", email, "--role", "owner", "--tenant", randomUUID());
    expect(result.code).toBe(1);
    expect(result.out).toContain("There's no business with the ID");
    const { rowCount } = await admin.query("SELECT 1 FROM users WHERE lower(email) = lower($1)", [
      email,
    ]);
    expect(rowCount).toBe(0);
  }, 30_000);
});
