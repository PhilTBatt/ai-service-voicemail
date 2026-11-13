import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { MOBILE_CODE_MAX_ATTEMPTS } from "../core/mobile-confirmation.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import { createAdminPool, createTenant, createUser } from "./cross-tenant.ts";
import { confirmMobile, pendingMobile, startMobileConfirmation } from "./mobile-confirmations.ts";
import { createPool } from "./pool.ts";
import { withTenant } from "./tenant.ts";

const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);
const NOW = new Date("2026-11-12T10:00:00Z");
const OLD_MOBILE = "+447700900701";
const NEW_MOBILE = "+447700900702";

afterAll(async () => {
  await Promise.all([app.end(), admin.end()]);
});

async function makeTenant() {
  const tenantId = await createTenant(admin, {
    businessName: "Confirm Plumbing",
    trade: "plumber",
    notificationMobile: OLD_MOBILE,
  });
  const userId = await createUser(admin, {
    email: `owner-${randomUUID()}@example.com`,
    role: "owner",
    authSubject: `sub_${randomUUID()}`,
  });
  return { tenantId, userId };
}

const storedMobile = async (tenantId: string) =>
  (
    await admin.query<{ notification_mobile: string | null }>(
      "SELECT notification_mobile FROM tenants WHERE id = $1",
      [tenantId],
    )
  ).rows[0]!.notification_mobile;

const auditActions = async (tenantId: string) =>
  (
    await admin.query<{ action: string; details: Record<string, unknown> }>(
      "SELECT action, details FROM audit_log WHERE tenant_id = $1 ORDER BY created_at",
      [tenantId],
    )
  ).rows;

const pending = (tenantId: string, at = NOW) =>
  withTenant(app, tenantId, (client) => pendingMobile(client, tenantId, at));

describe("startMobileConfirmation and confirmMobile", () => {
  it("saves the mobile only once its code is typed back, and audits without the number", async () => {
    const { tenantId, userId } = await makeTenant();
    const started = await startMobileConfirmation(app, tenantId, NEW_MOBILE, userId, NOW);
    expect(started.outcome).toBe("started");
    if (started.outcome !== "started") return;
    expect(started.code).toMatch(/^\d{6}$/);
    expect(started.expiresAt).toEqual(new Date(NOW.getTime() + 10 * 60_000));
    expect(await storedMobile(tenantId)).toBe(OLD_MOBILE);
    expect(await pending(tenantId)).toEqual({ mobile: NEW_MOBILE, expiresAt: started.expiresAt });

    // The code is kept hashed.
    const { rows } = await admin.query<{ code_hash: string }>(
      "SELECT code_hash FROM mobile_confirmations WHERE tenant_id = $1",
      [tenantId],
    );
    expect(rows[0]!.code_hash).not.toContain(started.code);

    expect(
      await confirmMobile(app, tenantId, started.code, userId, new Date(NOW.getTime() + 60_000)),
    ).toEqual({ outcome: "confirmed", mobile: NEW_MOBILE });
    expect(await storedMobile(tenantId)).toBe(NEW_MOBILE);
    expect(await pending(tenantId)).toBeNull();
    const audit = await auditActions(tenantId);
    expect(audit.map((row) => row.action)).toEqual(["mobile.code-sent", "notifications.changed"]);
    expect(audit[1]!.details).toEqual({
      via: "dashboard",
      changed: ["notificationMobile"],
      confirmed: true,
    });
    expect(JSON.stringify(audit)).not.toContain("900702");

    // Typed again: nothing is waiting.
    expect(await confirmMobile(app, tenantId, started.code, userId, NOW)).toEqual({
      outcome: "nothing-pending",
    });
  });

  it("refuses a wrong code five times, counting down, then stops taking tries", async () => {
    const { tenantId, userId } = await makeTenant();
    const started = await startMobileConfirmation(app, tenantId, NEW_MOBILE, userId, NOW);
    if (started.outcome !== "started") throw new Error("expected a code");
    const wrong = started.code === "000000" ? "000001" : "000000";
    for (let attempt = 1; attempt <= MOBILE_CODE_MAX_ATTEMPTS; attempt++) {
      expect(await confirmMobile(app, tenantId, wrong, userId, NOW)).toEqual({
        outcome: "wrong-code",
        attemptsLeft: MOBILE_CODE_MAX_ATTEMPTS - attempt,
      });
    }
    expect(await confirmMobile(app, tenantId, started.code, userId, NOW)).toEqual({
      outcome: "too-many-attempts",
    });
    expect(await storedMobile(tenantId)).toBe(OLD_MOBILE);
    // Nothing left to type into: the page asks for a new code.
    expect(await pending(tenantId)).toBeNull();
  });

  it("refuses a code after ten minutes", async () => {
    const { tenantId, userId } = await makeTenant();
    const started = await startMobileConfirmation(app, tenantId, NEW_MOBILE, userId, NOW);
    if (started.outcome !== "started") throw new Error("expected a code");
    const later = new Date(NOW.getTime() + 10 * 60_000);
    expect(await confirmMobile(app, tenantId, started.code, userId, later)).toEqual({
      outcome: "expired",
    });
    expect(await pending(tenantId, later)).toBeNull();
    expect(await storedMobile(tenantId)).toBe(OLD_MOBILE);
  });

  it("makes a new code stop the old one, and allows three an hour", async () => {
    const { tenantId, userId } = await makeTenant();
    const first = await startMobileConfirmation(app, tenantId, NEW_MOBILE, userId, NOW);
    const second = await startMobileConfirmation(
      app,
      tenantId,
      "+447700900703",
      userId,
      new Date(NOW.getTime() + 60_000),
    );
    if (first.outcome !== "started" || second.outcome !== "started")
      throw new Error("expected codes");
    // Only the latest counts, for the latest mobile.
    expect(await pending(tenantId, new Date(NOW.getTime() + 60_000))).toMatchObject({
      mobile: "+447700900703",
    });
    expect(await confirmMobile(app, tenantId, first.code, userId, NOW)).toMatchObject({
      outcome: first.code === second.code ? "confirmed" : "wrong-code",
    });

    const third = await startMobileConfirmation(app, tenantId, NEW_MOBILE, userId, NOW);
    expect(third.outcome).toBe("started");
    expect(await startMobileConfirmation(app, tenantId, NEW_MOBILE, userId, NOW)).toEqual({
      outcome: "too-many-codes",
      retryAt: new Date(NOW.getTime() + 60 * 60_000),
    });
    // An hour on, a code can be asked for again.
    expect(
      (
        await startMobileConfirmation(
          app,
          tenantId,
          NEW_MOBILE,
          userId,
          new Date(NOW.getTime() + 61 * 60_000),
        )
      ).outcome,
    ).toBe("started");
  });

  it("keeps each business's codes to itself", async () => {
    const { tenantId, userId } = await makeTenant();
    const other = await makeTenant();
    const started = await startMobileConfirmation(app, tenantId, NEW_MOBILE, userId, NOW);
    if (started.outcome !== "started") throw new Error("expected a code");
    expect(await confirmMobile(app, other.tenantId, started.code, other.userId, NOW)).toEqual({
      outcome: "nothing-pending",
    });
    expect(await storedMobile(other.tenantId)).toBe(OLD_MOBILE);
  });
});
