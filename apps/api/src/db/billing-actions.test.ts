// What an admin can do about a business's billing (db/billing-actions.ts): collect a failed
// payment again, suspend and resume, and take back a cancellation. Never automatic, always
// audited, and each one leaves the suspension record billing reads in the right shape.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { FakePaymentsProvider } from "../providers/payments.fake.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import { collectAgain, setSuspended, undoCancellation } from "./billing-actions.ts";
import { createAdminPool, createTenant } from "./cross-tenant.ts";
import { createPool } from "./pool.ts";
import { withTenant } from "./tenant.ts";

const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);

afterAll(async () => {
  await Promise.all([app.end(), admin.end()]);
});

async function adminUser() {
  return (
    await admin.query<{ id: string }>(
      "INSERT INTO users (auth_subject, email, role) VALUES ($1, $2, 'admin') RETURNING id",
      [`sub_${randomUUID()}`, `admin-${randomUUID()}@example.com`],
    )
  ).rows[0]!.id;
}

async function business(status = "live") {
  const tenantId = await createTenant(admin, {
    businessName: "Action Plumbing",
    trade: "plumber",
    notificationEmail: "actions@example.com",
  });
  await admin.query("UPDATE tenants SET status = $2 WHERE id = $1", [tenantId, status]);
  return tenantId;
}

/** One month's charge in the given state, with a payment unless nothing was asked for. */
async function chargeIn(tenantId: string, status: string) {
  const paymentRef = ["nothing_due", "below_minimum", "no_mandate", "collecting"].includes(status)
    ? null
    : `PM${randomUUID().replace(/-/g, "").slice(0, 14)}`;
  const id = await withTenant(
    app,
    tenantId,
    async (client) =>
      (
        await client.query<{ id: string }>(
          `INSERT INTO billing_charges (tenant_id, period_start, period_end, period_index,
             billable_seconds, fee_pence, overage_minutes, overage_pence, vat_rate_percent,
             vat_pence, total_pence, lines, status, payment_ref, failure_reason)
           VALUES ($1, '2026-09-14', '2026-10-14', 0, 0, 9900, 0, 0, 0, 0, 9900,
                   '[]', $2, $3, $4)
           RETURNING id`,
          [tenantId, status, paymentRef, status === "failed" ? "insufficient_funds" : null],
        )
      ).rows[0]!.id,
  );
  return { id, paymentRef };
}

const chargeRow = async (id: string) =>
  (
    await admin.query<{ status: string; failure_reason: string | null }>(
      "SELECT status, failure_reason FROM billing_charges WHERE id = $1",
      [id],
    )
  ).rows[0];

const audit = async (tenantId: string, action: string) =>
  (
    await admin.query<{ actor_user_id: string | null; details: unknown }>(
      "SELECT actor_user_id, details FROM audit_log WHERE tenant_id = $1 AND action = $2",
      [tenantId, action],
    )
  ).rows;

const suspensions = async (tenantId: string) =>
  (
    await admin.query<{ open: boolean }>(
      "SELECT ended_at IS NULL AS open FROM tenant_suspensions WHERE tenant_id = $1 ORDER BY started_at",
      [tenantId],
    )
  ).rows.map((row) => (row.open ? "open" : "ended"));

describe("collectAgain", () => {
  it("asks the provider to collect a failed payment again, as the same payment, and audits it", async () => {
    const tenantId = await business();
    const userId = await adminUser();
    const { id, paymentRef } = await chargeIn(tenantId, "failed");
    const payments = new FakePaymentsProvider();
    expect(await collectAgain(app, payments, tenantId, id, userId)).toEqual({
      outcome: "collecting",
      status: "pending",
    });
    expect(payments.retried).toEqual([paymentRef]);
    // No new payment: the same one, collected again.
    expect(payments.payments).toEqual([]);
    expect(await chargeRow(id)).toEqual({ status: "pending", failure_reason: null });
    expect(await audit(tenantId, "billing.collect-again")).toEqual([
      { actor_user_id: userId, details: { chargeId: id } },
    ]);
    // Pressed twice: the second finds it no longer failed, and the provider isn't asked again.
    expect(await collectAgain(app, payments, tenantId, id, userId)).toEqual({
      outcome: "not-failed",
      status: "pending",
    });
    expect(payments.retried).toHaveLength(1);
  });

  it.each([
    "pending",
    "submitted",
    "confirmed",
    "paid_out",
    "cancelled",
    "charged_back",
    "nothing_due",
    "below_minimum",
    "no_mandate",
    "collecting",
  ])("refuses a %s month before asking the provider anything", async (status) => {
    const tenantId = await business();
    const { id } = await chargeIn(tenantId, status);
    const payments = new FakePaymentsProvider();
    expect(await collectAgain(app, payments, tenantId, id, await adminUser())).toEqual({
      outcome: "not-failed",
      status,
    });
    expect(payments.retried).toEqual([]);
    expect((await chargeRow(id))?.status).toBe(status);
  });

  it("leaves the month failed, and records nothing, when the provider refuses", async () => {
    const tenantId = await business();
    const { id } = await chargeIn(tenantId, "failed");
    const payments = new FakePaymentsProvider().willFail(
      Object.assign(new Error("GoCardless: retry_failed"), { status: 422 }),
    );
    await expect(collectAgain(app, payments, tenantId, id, await adminUser())).rejects.toThrow(
      "retry_failed",
    );
    expect(await chargeRow(id)).toEqual({ status: "failed", failure_reason: "insufficient_funds" });
    expect(await audit(tenantId, "billing.collect-again")).toEqual([]);
  });

  it("can't reach another business's charge, or one that doesn't exist", async () => {
    const mine = await business();
    const theirs = await business();
    const { id } = await chargeIn(theirs, "failed");
    const payments = new FakePaymentsProvider();
    const userId = await adminUser();
    expect(await collectAgain(app, payments, mine, id, userId)).toEqual({ outcome: "not-found" });
    expect(await collectAgain(app, payments, mine, randomUUID(), userId)).toEqual({
      outcome: "not-found",
    });
    expect(payments.retried).toEqual([]);
    expect((await chargeRow(id))?.status).toBe("failed");
  });
});

describe("setSuspended", () => {
  it("suspends and resumes, keeping one record of each suspension, open until it ends", async () => {
    const tenantId = await business("live");
    const userId = await adminUser();
    expect(await setSuspended(app, tenantId, true, userId)).toEqual({
      outcome: "suspended",
      status: "suspended",
    });
    expect(await setSuspended(app, tenantId, true, userId)).toEqual({
      outcome: "unchanged",
      status: "suspended",
    });
    expect(await suspensions(tenantId)).toEqual(["open"]);
    expect(await setSuspended(app, tenantId, false, userId)).toEqual({
      outcome: "resumed",
      status: "live",
    });
    expect(await setSuspended(app, tenantId, false, userId)).toEqual({
      outcome: "unchanged",
      status: "live",
    });
    expect(await suspensions(tenantId)).toEqual(["ended"]);
    await setSuspended(app, tenantId, true, userId);
    expect(await suspensions(tenantId)).toEqual(["ended", "open"]);
    expect(await audit(tenantId, "tenant.suspended")).toHaveLength(2);
    expect(await audit(tenantId, "tenant.unsuspended")).toHaveLength(1);
  });

  it("suspends a paused business too, and resumes it to answering", async () => {
    const tenantId = await business("paused");
    const userId = await adminUser();
    expect((await setSuspended(app, tenantId, true, userId)).outcome).toBe("suspended");
    expect(await setSuspended(app, tenantId, false, userId)).toEqual({
      outcome: "resumed",
      status: "live",
    });
  });

  it.each(["onboarding", "cancelling", "cancelled", "demo"])(
    "won't suspend a business that's %s, and records no suspension",
    async (status) => {
      const tenantId = await business(status);
      expect(await setSuspended(app, tenantId, true, await adminUser())).toEqual({
        outcome: "not-allowed",
        status,
      });
      expect(await suspensions(tenantId)).toEqual([]);
    },
  );

  it("won't resume a business that wasn't suspended", async () => {
    const tenantId = await business("paused");
    expect(await setSuspended(app, tenantId, false, await adminUser())).toEqual({
      outcome: "not-allowed",
      status: "paused",
    });
  });

  it("keeps one open suspension when two admins press suspend at once", async () => {
    const tenantId = await business("live");
    const userId = await adminUser();
    const results = await Promise.all([
      setSuspended(app, tenantId, true, userId),
      setSuspended(app, tenantId, true, userId),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["suspended", "unchanged"]);
    expect(await suspensions(tenantId)).toEqual(["open"]);
  });

  it("never touches a payment: suspending is about calls, not money", async () => {
    const tenantId = await business("live");
    const { id } = await chargeIn(tenantId, "failed");
    await setSuspended(app, tenantId, true, await adminUser());
    expect(await chargeRow(id)).toEqual({ status: "failed", failure_reason: "insufficient_funds" });
  });
});

describe("undoCancellation", () => {
  async function leaving(from: string, suspended: boolean) {
    const tenantId = await business("cancelling");
    await admin.query(
      "UPDATE tenants SET cancellation_requested_at = '2026-10-01T10:00:00Z' WHERE id = $1",
      [tenantId],
    );
    await withTenant(app, tenantId, async (client) => {
      await client.query(
        "INSERT INTO audit_log (tenant_id, actor_user_id, action, details) VALUES ($1, NULL, 'tenant.cancel-requested', $2)",
        [tenantId, { from }],
      );
      if (suspended) {
        await client.query(
          "INSERT INTO tenant_suspensions (tenant_id, started_at) VALUES ($1, '2026-09-01T10:00:00Z')",
          [tenantId],
        );
      }
    });
    return tenantId;
  }

  it("puts a business back as it was, so it's billed again from its next month", async () => {
    const tenantId = await leaving("live", false);
    expect(await undoCancellation(app, admin, tenantId, await adminUser())).toEqual({
      outcome: "restored",
      status: "live",
    });
    const { rows } = await admin.query(
      "SELECT status, cancellation_requested_at FROM tenants WHERE id = $1",
      [tenantId],
    );
    expect(rows).toEqual([{ status: "live", cancellation_requested_at: null }]);
  });

  it("keeps a suspension open for a business that left while suspended and goes back to it", async () => {
    const tenantId = await leaving("suspended", true);
    expect((await undoCancellation(app, admin, tenantId, await adminUser())).status).toBe(
      "suspended",
    );
    expect(await suspensions(tenantId)).toEqual(["open"]);
  });

  it("ends the suspension when it can't go back to suspended, so later months are billed", async () => {
    // The audit row says something unexpected: back to paused, and the suspension closes.
    const tenantId = await leaving("something-else", true);
    expect((await undoCancellation(app, admin, tenantId, await adminUser())).status).toBe("paused");
    expect(await suspensions(tenantId)).toEqual(["ended"]);
  });

  it("only undoes a cancellation that's still in progress", async () => {
    const tenantId = await business("cancelled");
    expect(await undoCancellation(app, admin, tenantId, await adminUser())).toEqual({
      outcome: "not-allowed",
      status: "cancelled",
    });
  });
});
