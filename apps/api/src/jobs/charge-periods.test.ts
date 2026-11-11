import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createAdminPool, createTenant, type BillableTenant } from "../db/cross-tenant.ts";
import { createPool } from "../db/pool.ts";
import { withTenant } from "../db/tenant.ts";
import { FakePaymentsProvider } from "../providers/payments.fake.ts";
import { MandateUnusableError } from "../providers/payments.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import { chargePeriod, runChargePeriods, type ChargePeriodsDeps } from "./charge-periods.ts";

const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);

afterAll(async () => {
  await Promise.all([app.end(), admin.end()]);
});

const JUNE = { periodStart: "2026-06-14", periodEnd: "2026-07-14", index: 0 };
const JULY = { periodStart: "2026-07-14", periodEnd: "2026-08-14", index: 1 };

/** A live business that went live on 14 June, optionally with a Direct Debit and some usage. */
async function business({
  isPilot = false,
  mandate = true,
  seconds = {},
}: { isPilot?: boolean; mandate?: boolean; seconds?: Record<string, number> } = {}) {
  const tenantId = await createTenant(admin, {
    businessName: "Charged Plumbing",
    trade: "plumber",
    notificationEmail: "charged@example.com",
  });
  await admin.query(
    `UPDATE tenants SET status = 'live', onboarding_state = 'live', is_pilot = $2,
            billing_start_date = '2026-06-14' WHERE id = $1`,
    [tenantId, isPilot],
  );
  const mandateRef = mandate ? `MD${randomUUID().replace(/-/g, "").slice(0, 12)}` : null;
  if (mandateRef) await giveMandate(tenantId, mandateRef);
  for (const [periodStart, billable] of Object.entries(seconds)) {
    await admin.query(
      `INSERT INTO usage_periods (tenant_id, period_start, period_end, billable_seconds)
       VALUES ($1, $2, ($2::date + interval '1 month')::date, $3)`,
      [tenantId, periodStart, billable],
    );
  }
  const tenant: BillableTenant = {
    tenantId,
    billingStartDate: "2026-06-14",
    isPilot,
    leftOn: null,
  };
  return { tenantId, tenant, mandateRef };
}

/** An active Direct Debit, written as the app writes one: inside the business's own scope. */
async function giveMandate(tenantId: string, mandateRef: string) {
  await withTenant(app, tenantId, (client) =>
    client.query(
      `INSERT INTO payment_mandates (tenant_id, setup_ref, authorisation_url, expires_at, mandate_ref, status, activated_at)
       VALUES ($1, $2, 'https://pay.fake.invalid', now() + interval '7 days', $3, 'active', now())`,
      [tenantId, `BRQ${randomUUID()}`, mandateRef],
    ),
  );
}

function deps(overrides: Partial<ChargePeriodsDeps> = {}) {
  const payments = new FakePaymentsProvider();
  const enqueueBillingEmail = vi.fn(() => Promise.resolve());
  const alert = vi.fn();
  return {
    payments,
    enqueueBillingEmail,
    alert,
    deps: {
      pool: app,
      admin,
      payments,
      enqueueBillingEmail,
      alert,
      vat: null,
      now: () => new Date("2026-08-14T05:00:00Z"),
      ...overrides,
    } satisfies ChargePeriodsDeps,
  };
}

const charges = async (tenantId: string) =>
  (
    await admin.query<{
      period_start: string;
      status: string;
      total_pence: number;
      overage_minutes: number;
      payment_ref: string | null;
    }>(
      `SELECT period_start::text, status, total_pence, overage_minutes, payment_ref
       FROM billing_charges WHERE tenant_id = $1 ORDER BY period_start`,
      [tenantId],
    )
  ).rows;

describe("charging one month", () => {
  it("charges the fee and the overage rounded up once, collects it, and queues the receipt", async () => {
    // 201 minutes and 1 second: two minutes over, rounded up once for the month.
    const { tenantId, tenant, mandateRef } = await business({
      seconds: { "2026-06-14": 201 * 60 + 1 },
    });
    const { deps: d, payments, enqueueBillingEmail } = deps();
    expect(await chargePeriod(d, tenant, JUNE)).toBe("collected");

    expect(payments.payments).toEqual([
      expect.objectContaining({
        mandateRef,
        amountPence: 9940,
        description: "AnswerMate, 14 Jun 2026 to 13 Jul 2026",
        idempotencyKey: `charge:${tenantId}:2026-06-14`,
        metadata: { tenantId, periodStart: "2026-06-14" },
      }),
    ]);
    const [row] = await charges(tenantId);
    expect(row).toEqual({
      period_start: "2026-06-14",
      status: "pending",
      total_pence: 9940,
      overage_minutes: 2,
      payment_ref: payments.payments[0]!.paymentRef,
    });
    expect(enqueueBillingEmail).toHaveBeenCalledWith(
      { tenantId, kind: "receipt", ref: expect.any(String) as string },
      expect.anything(),
    );

    // Again: nothing more is charged or sent.
    expect(await chargePeriod(d, tenant, JUNE)).toBe("already-done");
    expect(payments.payments).toHaveLength(1);
    expect(enqueueBillingEmail).toHaveBeenCalledTimes(1);
  });

  it("records the pilot's free month inside its minutes as nothing due, and asks for nothing", async () => {
    const { tenantId, tenant } = await business({ isPilot: true, seconds: { "2026-06-14": 3600 } });
    const { deps: d, payments, enqueueBillingEmail } = deps();
    expect(await chargePeriod(d, tenant, JUNE)).toBe("nothing-due");
    expect(await charges(tenantId)).toEqual([
      expect.objectContaining({ status: "nothing_due", total_pence: 0, payment_ref: null }),
    ]);
    expect(payments.payments).toHaveLength(0);
    expect(enqueueBillingEmail).not.toHaveBeenCalled();
    // The pilot's second month is £49.
    expect(await chargePeriod(d, tenant, JULY)).toBe("collected");
    expect(payments.payments[0]?.amountPence).toBe(4900);
  });

  it("holds a month with no Direct Debit, alerts once, and collects it once there is one", async () => {
    const { tenantId, tenant } = await business({ mandate: false });
    const { deps: d, payments, alert } = deps();
    expect(await chargePeriod(d, tenant, JUNE)).toBe("no-mandate");
    expect(await chargePeriod(d, tenant, JUNE)).toBe("already-done");
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith("billing-no-mandate", {
      tenantId,
      periodStart: "2026-06-14",
      totalPence: 9900,
    });
    expect((await charges(tenantId))[0]?.status).toBe("no_mandate");

    await giveMandate(tenantId, "MD_LATER");
    expect(await chargePeriod(d, tenant, JUNE)).toBe("collected");
    expect(payments.payments[0]).toMatchObject({ mandateRef: "MD_LATER", amountPence: 9900 });
  });

  // The review of 2026-11-10: a payment the provider never made must never be reported to the
  // business as their payment failing.
  it("treats a Direct Debit the provider won't use as ended: the month waits for a new one", async () => {
    const { tenantId, tenant, mandateRef } = await business();
    const { deps: d, payments, alert, enqueueBillingEmail } = deps();
    payments.willFail(new MandateUnusableError("GoCardless /payments failed: mandate is inactive"));
    expect(await chargePeriod(d, tenant, JUNE)).toBe("no-mandate");
    expect((await charges(tenantId))[0]?.status).toBe("no_mandate");
    const { rows } = await admin.query(
      "SELECT status, end_reason FROM payment_mandates WHERE mandate_ref = $1",
      [mandateRef],
    );
    expect(rows).toEqual([{ status: "cancelled", end_reason: "mandate_unusable" }]);
    expect(alert).toHaveBeenCalledWith("payment-mandate-ended", {
      tenantId,
      status: "cancelled",
      reason: "mandate_unusable",
    });
    expect(enqueueBillingEmail).toHaveBeenCalledWith(
      { tenantId, kind: "direct_debit_ended", ref: mandateRef },
      expect.anything(),
    );
    expect(enqueueBillingEmail).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "payment_failed" }),
      expect.anything(),
    );
    // Set up again: the month is collected.
    await giveMandate(tenantId, "MD_NEW_ONE");
    expect(await chargePeriod(d, tenant, JUNE)).toBe("collected");
    expect(payments.payments[0]).toMatchObject({ mandateRef: "MD_NEW_ONE" });
  });

  it("fails the run, and says nothing to the business, when the request itself is refused", async () => {
    // A wrong or revoked access token, say: ours to fix, not the customer's payment failing.
    const { tenantId, tenant } = await business();
    const { deps: d, payments, alert, enqueueBillingEmail } = deps();
    payments.willFail(Object.assign(new Error("GoCardless: HTTP 401 bad token"), { status: 401 }));
    await expect(chargePeriod(d, tenant, JUNE)).rejects.toThrow("401");
    expect((await charges(tenantId))[0]?.status).toBe("collecting");
    expect(alert).not.toHaveBeenCalled();
    expect(enqueueBillingEmail).not.toHaveBeenCalled();
    expect(await chargePeriod(d, tenant, JUNE)).toBe("collected");
  });

  it("records, and doesn't try to collect, a month owing less than the provider's £1 minimum", async () => {
    // The pilot's free month, a minute over: 20p.
    const { tenantId, tenant } = await business({
      isPilot: true,
      seconds: { "2026-06-14": 201 * 60 },
    });
    const { deps: d, payments, enqueueBillingEmail } = deps();
    expect(await chargePeriod(d, tenant, JUNE)).toBe("below-minimum");
    expect(await charges(tenantId)).toEqual([
      expect.objectContaining({ status: "below_minimum", total_pence: 20, payment_ref: null }),
    ]);
    expect(payments.payments).toHaveLength(0);
    expect(enqueueBillingEmail).not.toHaveBeenCalled();
    expect(await chargePeriod(d, tenant, JUNE)).toBe("already-done");
  });

  it("never switches a business off, whatever happens to its payments", async () => {
    // BUILD_PLAN Step 12's named test: a failed payment does not suspend the tenant.
    const { tenantId, tenant } = await business({ mandate: false });
    const { deps: d } = deps();
    await chargePeriod(d, tenant, JUNE);
    const { rows } = await admin.query("SELECT status FROM tenants WHERE id = $1", [tenantId]);
    expect(rows).toEqual([{ status: "live" }]);
  });

  it("leaves a month mid-collection after the provider's trouble, and finishes it next time", async () => {
    const { tenantId, tenant } = await business();
    const { deps: d, payments } = deps();
    payments.willFail("GoCardless is down");
    await expect(chargePeriod(d, tenant, JUNE)).rejects.toThrow("GoCardless is down");
    expect((await charges(tenantId))[0]?.status).toBe("collecting");
    expect(await chargePeriod(d, tenant, JUNE)).toBe("collected");
    expect(payments.payments).toHaveLength(1);
  });
});

describe("the morning run", () => {
  it("charges every ended month of a paying business, and never the demo line or a test business", async () => {
    const paying = await business({ seconds: { "2026-06-14": 60 } });
    const demo = await business();
    await admin.query("UPDATE tenants SET status = 'demo' WHERE id = $1", [demo.tenantId]);
    const test = await business();
    await admin.query("UPDATE tenants SET is_test = true WHERE id = $1", [test.tenantId]);
    const left = await business();
    await admin.query(
      "UPDATE tenants SET status = 'cancelling', cancellation_requested_at = '2026-06-20T10:00:00Z' WHERE id = $1",
      [left.tenantId],
    );

    // 14 August: June's and July's months have ended.
    const { deps: d } = deps();
    await runChargePeriods(d);
    expect((await charges(paying.tenantId)).map((c) => c.period_start)).toEqual([
      "2026-06-14",
      "2026-07-14",
    ]);
    expect(await charges(demo.tenantId)).toEqual([]);
    expect(await charges(test.tenantId)).toEqual([]);
    // It asked to leave in June's month: that month is charged, July's isn't.
    expect((await charges(left.tenantId)).map((c) => c.period_start)).toEqual(["2026-06-14"]);
  });
});
