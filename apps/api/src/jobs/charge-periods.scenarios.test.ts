// Charging over whole lifetimes (decision 019), against real Postgres: a pilot's first year run
// morning by morning, months caught up after missed mornings, runs that crash part-way or lose
// the provider's answer, two runs at once, the £1 minimum, suspensions across months and clock
// changes, leaving, VAT starting, and the businesses that never pay. Whatever happens: one
// charge per business per month, one payment per charge, never a business switched off.
//
// runChargePeriods charges every paying business in the database, and other test files run
// alongside this one. Each run here sees only its own test's businesses (scopedAdmin), and
// every business here goes live after 14 July 2026, so the morning run in charge-periods.test.ts
// (14 August 2026) never reaches them either.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { startOfUkDate } from "../core/usage.ts";
import { createAdminPool, createTenant, type AdminPool } from "../db/cross-tenant.ts";
import { createPool } from "../db/pool.ts";
import { withTenant } from "../db/tenant.ts";
import { FakePaymentsProvider } from "../providers/payments.fake.ts";
import {
  MandateUnusableError,
  type PaymentReceipt,
  type PaymentRequest,
} from "../providers/payments.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import type { BillingEmailJobData } from "./billing-email.ts";
import { runChargePeriods, type ChargePeriodsDeps } from "./charge-periods.ts";

const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);

afterAll(async () => {
  await Promise.all([app.end(), admin.end()]);
});

/**
 * The provider, scripted: a request can fail outright (the provider down), or reach the
 * provider and have its answer lost on the way back (a timeout after it made the payment).
 */
class ScriptedPayments extends FakePaymentsProvider {
  readonly failKeys = new Set<string>();
  readonly loseAnswerKeys = new Set<string>();
  readonly unusableMandates = new Set<string>();
  readonly requests: string[] = [];

  override async createPayment(request: PaymentRequest): Promise<PaymentReceipt> {
    this.requests.push(request.idempotencyKey);
    if (this.failKeys.delete(request.idempotencyKey)) throw new Error("GoCardless is down");
    if (this.unusableMandates.has(request.mandateRef)) {
      throw new MandateUnusableError("GoCardless /payments failed: mandate is inactive");
    }
    const receipt = await super.createPayment(request);
    if (this.loseAnswerKeys.delete(request.idempotencyKey)) throw new Error("socket hang up");
    return receipt;
  }
}

/** The admin pool, as runChargePeriods uses it, seeing only these businesses. */
function scopedAdmin(tenantIds: string[]): AdminPool {
  return {
    query: async (text: string, values?: unknown[]) => {
      const result = await admin.query<{ tenantId: string }>(text, values);
      return { ...result, rows: result.rows.filter((row) => tenantIds.includes(row.tenantId)) };
    },
  } as unknown as AdminPool;
}

/** 06:00 UK time on a date: when the morning run goes. */
const morningOf = (date: string) => new Date(startOfUkDate(date).getTime() + 6 * 3_600_000);

interface BusinessOptions {
  anchor: string;
  isPilot?: boolean;
  mandate?: boolean;
  /** Billable seconds by period start. */
  usage?: Record<string, number>;
}

async function business({ anchor, isPilot = false, mandate = true, usage = {} }: BusinessOptions) {
  const tenantId = await createTenant(admin, {
    businessName: "Lifetime Plumbing",
    trade: "plumber",
    notificationEmail: "lifetime@example.com",
  });
  await admin.query(
    `UPDATE tenants SET status = 'live', onboarding_state = 'live', is_pilot = $2,
            billing_start_date = $3 WHERE id = $1`,
    [tenantId, isPilot, anchor],
  );
  const mandateRef = mandate ? await giveMandate(tenantId) : null;
  for (const [periodStart, seconds] of Object.entries(usage)) {
    await admin.query(
      `INSERT INTO usage_periods (tenant_id, period_start, period_end, billable_seconds)
       VALUES ($1, $2, ($2::date + interval '1 month')::date, $3)`,
      [tenantId, periodStart, seconds],
    );
  }
  return { tenantId, mandateRef };
}

async function giveMandate(tenantId: string) {
  const mandateRef = `MD${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await withTenant(app, tenantId, (client) =>
    client.query(
      `INSERT INTO payment_mandates (tenant_id, setup_ref, authorisation_url, expires_at, mandate_ref, status, activated_at)
       VALUES ($1, $2, 'https://pay.fake.invalid', now() + interval '7 days', $3, 'active', now())`,
      [tenantId, `BRQ${randomUUID()}`, mandateRef],
    ),
  );
  return mandateRef;
}

async function suspend(tenantId: string, startedAt: string, endedAt: string | null) {
  await withTenant(app, tenantId, (client) =>
    client.query(
      "INSERT INTO tenant_suspensions (tenant_id, started_at, ended_at) VALUES ($1, $2, $3)",
      [tenantId, startedAt, endedAt],
    ),
  );
}

function harness(tenantIds: string[], overrides: Partial<ChargePeriodsDeps> = {}) {
  const payments = new ScriptedPayments();
  const enqueueBillingEmail = vi.fn((_job: BillingEmailJobData, _client?: unknown) =>
    Promise.resolve(),
  );
  const alert = vi.fn();
  const run = (date: Date) =>
    runChargePeriods({
      pool: app,
      admin: scopedAdmin(tenantIds),
      payments,
      enqueueBillingEmail,
      alert,
      vat: null,
      ...overrides,
      now: () => date,
    });
  const emails = (kind: BillingEmailJobData["kind"]) =>
    enqueueBillingEmail.mock.calls.filter(([job]) => job.kind === kind);
  return { payments, enqueueBillingEmail, alert, run, emails };
}

interface ChargeRow {
  id: string;
  period_start: string;
  period_end: string;
  period_index: number;
  billable_seconds: number;
  fee_pence: number;
  overage_minutes: number;
  overage_pence: number;
  vat_pence: number;
  total_pence: number;
  vat_number: string | null;
  status: string;
  payment_ref: string | null;
}

const charges = async (tenantId: string) =>
  (
    await admin.query<ChargeRow>(
      `SELECT id, period_start::text, period_end::text, period_index, billable_seconds::int,
              fee_pence, overage_minutes, overage_pence, vat_pence, total_pence, vat_number,
              status, payment_ref
       FROM billing_charges WHERE tenant_id = $1 ORDER BY period_start`,
      [tenantId],
    )
  ).rows;

const tenantStatus = async (tenantId: string) =>
  (await admin.query<{ status: string }>("SELECT status FROM tenants WHERE id = $1", [tenantId]))
    .rows[0]?.status;

const ZERO_RUN = {
  periods: 0,
  collected: 0,
  nothingDue: 0,
  belowMinimum: 0,
  noMandate: 0,
  refused: 0,
  failedBusinesses: 0,
};

describe("a pilot's first year, run every morning", () => {
  it("charges each month once, the morning after it ends, at the pilot's price then the plan's", async () => {
    // Live on 31 January 2027: months end on the last day of shorter months.
    const anchor = "2027-01-31";
    const starts = [
      "2027-01-31",
      "2027-02-28",
      "2027-03-31",
      "2027-04-30",
      "2027-05-31",
      "2027-06-30",
      "2027-07-31",
      "2027-08-31",
      "2027-09-30",
      "2027-10-31",
      "2027-11-30",
      "2027-12-31",
    ];
    const ends = [...starts.slice(1), "2028-01-31"];
    const { tenantId, mandateRef } = await business({
      anchor,
      isPilot: true,
      // The free month two minutes over (40p, under the £1 minimum); the second month 50 over.
      usage: { "2027-01-31": 202 * 60, "2027-02-28": 250 * 60 - 30 },
    });
    const { payments, run, emails, alert } = harness([tenantId]);

    for (const end of ends) {
      // The evening before a month ends: nothing new.
      const before = await run(new Date(startOfUkDate(end).getTime() - 60_000));
      expect(before, `before ${end}`).toEqual(ZERO_RUN);
      // The morning after: exactly that month.
      const counts = await run(morningOf(end));
      expect(counts.periods, `on ${end}`).toBe(1);
      // Run again the same morning: nothing more.
      expect(await run(morningOf(end))).toEqual(ZERO_RUN);
    }

    const rows = await charges(tenantId);
    expect(rows.map((row) => [row.period_start, row.period_end])).toEqual(
      starts.map((start, i) => [start, ends[i]]),
    );
    expect(rows.map((row) => row.period_index)).toEqual(starts.map((_, i) => i));
    expect(rows.map((row) => row.fee_pence)).toEqual([
      0, 4900, 4900, 4900, 9900, 9900, 9900, 9900, 9900, 9900, 9900, 9900,
    ]);
    expect(rows.map((row) => row.total_pence)).toEqual([
      40, 5900, 4900, 4900, 9900, 9900, 9900, 9900, 9900, 9900, 9900, 9900,
    ]);
    expect(rows[0]).toMatchObject({
      status: "below_minimum",
      overage_minutes: 2,
      payment_ref: null,
    });
    expect(rows.slice(1).every((row) => row.status === "pending")).toBe(true);

    // One payment per month collected, oldest first, each keyed by the business and the month.
    expect(payments.payments.map((p) => [p.idempotencyKey, p.amountPence, p.mandateRef])).toEqual(
      rows
        .slice(1)
        .map((row) => [`charge:${tenantId}:${row.period_start}`, row.total_pence, mandateRef]),
    );
    expect(new Set(payments.requests).size).toBe(11);
    expect(emails("receipt")).toHaveLength(11);
    expect(alert).not.toHaveBeenCalled();
    // A year's takings: 40p waived, £59 + 2 × £49 + 8 × £99.
    expect(payments.payments.reduce((sum, p) => sum + p.amountPence, 0)).toBe(5900 + 9800 + 79_200);
  });
});

describe("missed mornings", () => {
  it("catches up every ended month in one run, oldest first, and nothing still running", async () => {
    const { tenantId } = await business({ anchor: "2026-09-30" });
    const { payments, run } = harness([tenantId]);
    expect(await run(morningOf("2027-03-31"))).toEqual({ ...ZERO_RUN, periods: 6, collected: 6 });
    expect((await charges(tenantId)).map((row) => row.period_start)).toEqual([
      "2026-09-30",
      "2026-10-30",
      "2026-11-30",
      "2026-12-30",
      "2027-01-30",
      "2027-02-28",
    ]);
    expect(payments.payments.map((p) => p.metadata["periodStart"])).toEqual([
      "2026-09-30",
      "2026-10-30",
      "2026-11-30",
      "2026-12-30",
      "2027-01-30",
      "2027-02-28",
    ]);
    // The month from 30 March is still running.
    expect(await run(morningOf("2027-04-29"))).toEqual(ZERO_RUN);
    expect(await run(morningOf("2027-04-30"))).toEqual({ ...ZERO_RUN, periods: 1, collected: 1 });
  });
});

describe("runs that stop part-way", () => {
  it("finishes a business whose second month the provider refused, and leaves the others alone", async () => {
    const steady = await business({ anchor: "2026-08-20" });
    const troubled = await business({ anchor: "2026-08-20" });
    const { payments, run, enqueueBillingEmail, alert } = harness([
      steady.tenantId,
      troubled.tenantId,
    ]);
    payments.failKeys.add(`charge:${troubled.tenantId}:2026-09-20`);

    await expect(run(morningOf("2026-11-20"))).rejects.toThrow(
      "Charging failed for 1 business(es); retrying",
    );
    // The steady business: all three months. The troubled one: the first collected, the second
    // made and mid-collection, the third not yet reached.
    expect((await charges(steady.tenantId)).map((row) => row.status)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
    expect((await charges(troubled.tenantId)).map((row) => [row.period_start, row.status])).toEqual(
      [
        ["2026-08-20", "pending"],
        ["2026-09-20", "collecting"],
      ],
    );
    // Nothing said to the business about a payment that was never made.
    expect(alert).not.toHaveBeenCalled();
    expect(
      enqueueBillingEmail.mock.calls.filter(([job]) => job.tenantId === troubled.tenantId),
    ).toHaveLength(1);

    // The queue's retry: the rest of the troubled business, and nothing twice.
    expect(await run(morningOf("2026-11-20"))).toEqual({ ...ZERO_RUN, periods: 2, collected: 2 });
    expect((await charges(troubled.tenantId)).map((row) => row.status)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
    expect(payments.payments).toHaveLength(6);
    expect(new Set(payments.payments.map((p) => p.paymentRef)).size).toBe(6);
    expect(enqueueBillingEmail.mock.calls.filter(([job]) => job.kind === "receipt")).toHaveLength(
      6,
    );
  });

  it("gets the same payment back, not a second, when the provider's answer was lost", async () => {
    const { tenantId } = await business({ anchor: "2026-08-21" });
    const { payments, run, emails } = harness([tenantId]);
    payments.loseAnswerKeys.add(`charge:${tenantId}:2026-08-21`);
    await expect(run(morningOf("2026-09-21"))).rejects.toThrow("retrying");
    // The provider has the payment; we don't know it yet.
    expect(payments.payments).toHaveLength(1);
    expect((await charges(tenantId))[0]).toMatchObject({ status: "collecting", payment_ref: null });
    expect(emails("receipt")).toHaveLength(0);

    expect(await run(morningOf("2026-09-21"))).toEqual({ ...ZERO_RUN, periods: 1, collected: 1 });
    expect(payments.payments).toHaveLength(1);
    expect((await charges(tenantId))[0]).toMatchObject({
      status: "pending",
      payment_ref: payments.payments[0]!.paymentRef,
    });
    expect(emails("receipt")).toHaveLength(1);
  });

  it.each([
    ["pending_submission", "pending", "receipt"],
    ["submitted", "submitted", "receipt"],
    ["confirmed", "confirmed", "receipt"],
    ["paid_out", "paid_out", "receipt"],
    ["cancelled", "cancelled", "payment_failed"],
    ["failed", "failed", "payment_failed"],
    ["customer_approval_denied", "failed", "payment_failed"],
    ["charged_back", "charged_back", "payment_failed"],
    ["something_new", "pending", "receipt"],
  ])(
    "records a lost payment as the provider has it by the retry: %s as %s",
    async (providerStatus, recorded, email) => {
      const { tenantId } = await business({ anchor: "2026-08-22" });
      const { payments, run, emails, alert } = harness([tenantId]);
      payments.loseAnswerKeys.add(`charge:${tenantId}:2026-08-22`);
      await expect(run(morningOf("2026-09-22"))).rejects.toThrow("retrying");
      payments.payments[0]!.status = providerStatus;

      const counts = await run(morningOf("2026-09-22"));
      expect((await charges(tenantId))[0]?.status).toBe(recorded);
      expect(emails(email as BillingEmailJobData["kind"])).toHaveLength(1);
      expect(enqueueCount(emails)).toBe(1);
      if (email === "payment_failed") {
        expect(counts).toEqual({ ...ZERO_RUN, periods: 1, refused: 1 });
        expect(alert).toHaveBeenCalledWith("billing-payment-failed", {
          tenantId,
          periodStart: "2026-08-22",
          status: recorded,
          reason: null,
        });
      } else {
        expect(counts).toEqual({ ...ZERO_RUN, periods: 1, collected: 1 });
        expect(alert).not.toHaveBeenCalled();
      }
      expect(await tenantStatus(tenantId)).toBe("live");
    },
  );

  it("never charges twice when two runs go at once", async () => {
    const { tenantId } = await business({ anchor: "2026-08-23" });
    const { payments, run, emails } = harness([tenantId]);
    const results = await Promise.allSettled([
      run(morningOf("2026-11-23")),
      run(morningOf("2026-11-23")),
      run(morningOf("2026-11-23")),
    ]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    // Whatever the overlap left undone, the next run finishes.
    await run(morningOf("2026-11-23"));
    const rows = await charges(tenantId);
    expect(rows.map((row) => row.status)).toEqual(["pending", "pending", "pending"]);
    expect(payments.payments).toHaveLength(3);
    expect(new Set(rows.map((row) => row.payment_ref))).toEqual(
      new Set(payments.payments.map((p) => p.paymentRef)),
    );
    expect(emails("receipt")).toHaveLength(3);
    expect(await run(morningOf("2026-11-23"))).toEqual(ZERO_RUN);
  });
});

/** How many billing emails were queued in all, given the per-kind reader. */
function enqueueCount(emails: (kind: BillingEmailJobData["kind"]) => unknown[]): number {
  return (["receipt", "payment_failed", "direct_debit_ended"] as const).reduce(
    (sum, kind) => sum + emails(kind).length,
    0,
  );
}

describe("the £1 minimum", () => {
  it.each([
    // [minutes in the pilot's free month, VAT on, total, status]
    [204, false, 80, "below_minimum"],
    [205, false, 100, "pending"],
    [204, true, 96, "below_minimum"],
    [205, true, 120, "pending"],
    [200, false, 0, "nothing_due"],
    [200, true, 0, "nothing_due"],
  ] as const)("%i minutes, VAT %s: %ip, %s", async (minutes, vatOn, total, status) => {
    const { tenantId } = await business({
      anchor: "2026-08-24",
      isPilot: true,
      usage: { "2026-08-24": minutes * 60 },
    });
    const { payments, run, emails } = harness([tenantId], {
      vat: vatOn ? { number: "GB000000000", from: "2026-01-01" } : null,
    });
    await run(morningOf("2026-09-24"));
    expect(await charges(tenantId)).toEqual([
      expect.objectContaining({ total_pence: total, status }),
    ]);
    expect(payments.payments).toHaveLength(status === "pending" ? 1 : 0);
    expect(emails("receipt")).toHaveLength(status === "pending" ? 1 : 0);
    // Waived months stay waived: never collected later, never carried into the next month.
    await run(morningOf("2026-10-24"));
    expect((await charges(tenantId))[0]?.status).toBe(status);
    expect((await charges(tenantId))[1]?.total_pence).toBe(vatOn ? 5880 : 4900);
  });
});

describe("suspensions", () => {
  it("charges the month a suspension began in and the one it ended in, and nothing between", async () => {
    const { tenantId } = await business({ anchor: "2026-08-25" });
    await suspend(tenantId, "2026-10-01T10:00:00Z", "2027-01-10T10:00:00Z");
    const { payments, run, emails } = harness([tenantId]);
    await run(morningOf("2027-02-25"));
    expect(
      (await charges(tenantId)).map((row) => [row.period_start, row.status, row.total_pence]),
    ).toEqual([
      ["2026-08-25", "pending", 9900],
      ["2026-09-25", "pending", 9900], // suspended on 1 October, part-way through
      ["2026-10-25", "nothing_due", 0],
      ["2026-11-25", "nothing_due", 0],
      ["2026-12-25", "pending", 9900], // resumed on 10 January, part-way through
      ["2027-01-25", "pending", 9900],
    ]);
    expect(payments.payments).toHaveLength(4);
    expect(emails("receipt")).toHaveLength(4);
  });

  it("measures a month that starts the day the clocks go back from its UK midnight (23:00 UTC)", async () => {
    // The month from 25 October 2026 begins at 00:00 BST, 23:00 UTC on the 24th, and ends at
    // 00:00 GMT on 25 November.
    const cases = [
      { from: "2026-10-24T23:00:00Z", to: "2026-11-25T00:00:00Z", status: "nothing_due" },
      { from: "2026-10-24T23:00:00Z", to: null, status: "nothing_due" },
      { from: "2026-10-24T23:00:01Z", to: null, status: "pending" },
      { from: "2026-10-25T00:00:00Z", to: null, status: "pending" }, // 01:00 BST: an hour served
      { from: "2026-10-24T23:00:00Z", to: "2026-11-24T23:59:59Z", status: "pending" },
    ];
    const businesses = await Promise.all(cases.map(() => business({ anchor: "2026-09-25" })));
    for (const [i, { from, to }] of cases.entries())
      await suspend(businesses[i]!.tenantId, from, to);
    const { run } = harness(businesses.map((b) => b.tenantId));
    await run(morningOf("2026-11-25"));
    for (const [i, { from, to, status }] of cases.entries()) {
      expect((await charges(businesses[i]!.tenantId))[1], `${from} to ${to}`).toMatchObject({
        period_start: "2026-10-25",
        status,
      });
    }
  });

  it("measures a month that starts the day the clocks go forward from 00:00 GMT", async () => {
    const whole = await business({ anchor: "2027-02-28" });
    const late = await business({ anchor: "2027-02-28" });
    // The month from 28 March 2027 (the clocks go forward that night) to 28 April (BST).
    await suspend(whole.tenantId, "2027-03-28T00:00:00Z", "2027-04-27T23:00:00Z");
    await suspend(late.tenantId, "2027-03-28T00:00:00Z", "2027-04-27T22:59:59Z");
    const { run } = harness([whole.tenantId, late.tenantId]);
    await run(morningOf("2027-04-28"));
    expect((await charges(whole.tenantId))[1]).toMatchObject({
      period_start: "2027-03-28",
      status: "nothing_due",
    });
    expect((await charges(late.tenantId))[1]).toMatchObject({
      period_start: "2027-03-28",
      status: "pending",
    });
  });

  it("charges a month with a day of service between two suspensions", async () => {
    const { tenantId } = await business({ anchor: "2026-08-26" });
    await suspend(tenantId, "2026-09-01T10:00:00Z", "2026-10-01T10:00:00Z");
    await suspend(tenantId, "2026-10-02T10:00:00Z", null);
    const { run } = harness([tenantId]);
    await run(morningOf("2026-11-26"));
    expect((await charges(tenantId)).map((row) => row.status)).toEqual([
      "pending", // suspended from 1 September, part-way
      "pending", // a day of service on 1 to 2 October
      "nothing_due", // suspended throughout
    ]);
  });
});

describe("leaving", () => {
  it.each([
    // 23:59 BST on 14 October is still the 14th in the UK: the month that began that day began
    // on the day it asked to leave (decision 019: "on or after"), so it isn't charged.
    ["2026-10-14T22:59:00Z", ["2026-09-14"]],
    // A minute later it's 15 October in the UK: the month from the 14th began before it asked.
    ["2026-10-14T23:00:00Z", ["2026-09-14", "2026-10-14"]],
    // In winter UK time is UTC.
    ["2026-11-14T00:30:00Z", ["2026-09-14", "2026-10-14"]],
    ["2026-11-13T23:59:00Z", ["2026-09-14", "2026-10-14"]],
    ["2026-11-15T00:00:00Z", ["2026-09-14", "2026-10-14", "2026-11-14"]],
  ])("asked to leave at %s: charged for %j and nothing after", async (at, charged) => {
    const { tenantId } = await business({ anchor: "2026-09-14" });
    await admin.query(
      "UPDATE tenants SET status = 'cancelled', cancellation_requested_at = $2 WHERE id = $1",
      [tenantId, at],
    );
    const { run } = harness([tenantId]);
    // A year on, every morning that matters has passed.
    for (const date of ["2026-10-14", "2026-11-14", "2026-12-14", "2027-09-14"]) {
      await run(morningOf(date));
    }
    expect((await charges(tenantId)).map((row) => row.period_start)).toEqual(charged);
    expect((await charges(tenantId)).every((row) => row.fee_pence === 9900)).toBe(true);
  });
});

describe("businesses that never pay", () => {
  it("never charges a test business or the demo line, with usage and a Direct Debit, all year", async () => {
    const test = await business({ anchor: "2026-08-27", usage: { "2026-08-27": 500 * 60 } });
    await admin.query("UPDATE tenants SET is_test = true WHERE id = $1", [test.tenantId]);
    const demo = await business({ anchor: "2026-08-27", usage: { "2026-08-27": 500 * 60 } });
    await admin.query("UPDATE tenants SET status = 'demo' WHERE id = $1", [demo.tenantId]);
    const notLive = await createTenant(admin, {
      businessName: "Not Yet Plumbing",
      trade: "plumber",
    });
    const { payments, run } = harness([test.tenantId, demo.tenantId, notLive]);
    for (const date of ["2026-09-27", "2027-03-27", "2027-08-27"]) {
      expect(await run(morningOf(date))).toEqual(ZERO_RUN);
    }
    for (const tenantId of [test.tenantId, demo.tenantId, notLive]) {
      expect(await charges(tenantId)).toEqual([]);
    }
    expect(payments.requests).toEqual([]);
  });
});

describe("Direct Debits that aren't there", () => {
  it("holds months with no Direct Debit, alerting once each, then collects them all when one arrives", async () => {
    const { tenantId } = await business({ anchor: "2026-08-28", mandate: false });
    const { payments, run, alert, emails } = harness([tenantId]);
    for (const date of ["2026-09-28", "2026-09-29", "2026-10-28", "2026-11-28", "2026-11-29"]) {
      await run(morningOf(date));
    }
    expect((await charges(tenantId)).map((row) => row.status)).toEqual([
      "no_mandate",
      "no_mandate",
      "no_mandate",
    ]);
    expect(
      alert.mock.calls.map((call): [string, string] => [
        String(call[0]),
        (call[1] as { periodStart: string }).periodStart,
      ]),
    ).toEqual([
      ["billing-no-mandate", "2026-08-28"],
      ["billing-no-mandate", "2026-09-28"],
      ["billing-no-mandate", "2026-10-28"],
    ]);
    expect(payments.requests).toEqual([]);

    const mandateRef = await giveMandate(tenantId);
    expect(await run(morningOf("2026-11-30"))).toEqual({ ...ZERO_RUN, periods: 3, collected: 3 });
    expect(payments.payments.map((p) => [p.metadata["periodStart"], p.mandateRef])).toEqual([
      ["2026-08-28", mandateRef],
      ["2026-09-28", mandateRef],
      ["2026-10-28", mandateRef],
    ]);
    expect(emails("receipt")).toHaveLength(3);
    expect(await tenantStatus(tenantId)).toBe("live");
  });

  it("ends a Direct Debit the provider won't use once, and holds every month after for a new one", async () => {
    const { tenantId, mandateRef } = await business({ anchor: "2026-08-29" });
    const { payments, run, alert, emails } = harness([tenantId]);
    await run(morningOf("2026-09-29"));
    payments.unusableMandates.add(mandateRef!);
    await run(morningOf("2026-10-29"));
    await run(morningOf("2026-11-29"));
    expect((await charges(tenantId)).map((row) => row.status)).toEqual([
      "pending",
      "no_mandate",
      "no_mandate",
    ]);
    expect(alert.mock.calls.filter(([name]) => name === "payment-mandate-ended")).toHaveLength(1);
    expect(emails("direct_debit_ended")).toHaveLength(1);
    expect(emails("payment_failed")).toHaveLength(0);
    expect(await tenantStatus(tenantId)).toBe("live");
  });
});

describe("VAT", () => {
  it("adds VAT to months that begin on or after the registration date, and records the number", async () => {
    const { tenantId } = await business({
      anchor: "2026-10-20",
      usage: { "2026-12-20": 200 * 60 + 1, "2027-01-20": 200 * 60 + 1 },
    });
    const { payments, run } = harness([tenantId], {
      vat: { number: "GB999999973", from: "2027-01-01" },
    });
    await run(morningOf("2027-03-20"));
    expect(
      (await charges(tenantId)).map((row) => [
        row.period_start,
        row.total_pence,
        row.vat_pence,
        row.vat_number,
      ]),
    ).toEqual([
      ["2026-10-20", 9900, 0, null],
      ["2026-11-20", 9900, 0, null],
      ["2026-12-20", 9920, 0, null], // began before the registration, though it runs past it
      ["2027-01-20", 11_904, 1984, "GB999999973"],
      ["2027-02-20", 11_880, 1980, "GB999999973"],
    ]);
    expect(payments.payments.map((p) => p.amountPence)).toEqual([9900, 9900, 9920, 11_904, 11_880]);
  });
});

describe("what's read for a month", () => {
  it("charges the fee alone with no usage, and ignores usage recorded for other months", async () => {
    const { tenantId } = await business({
      anchor: "2026-08-30",
      // A calendar month's row and a row for a month not yet ended: neither is August's month.
      usage: { "2026-09-01": 900 * 60, "2026-09-30": 900 * 60 },
    });
    const { run } = harness([tenantId]);
    await run(morningOf("2026-09-30"));
    expect(await charges(tenantId)).toEqual([
      expect.objectContaining({
        period_start: "2026-08-30",
        billable_seconds: 0,
        overage_minutes: 0,
        total_pence: 9900,
      }),
    ]);
  });

  it("keeps the month's charge as first worked out, even if usage arrives afterwards", async () => {
    // Decision 019's accepted edge: a late call after the morning run isn't billed.
    const { tenantId } = await business({ anchor: "2026-08-31", usage: { "2026-08-31": 100 } });
    const { run, payments } = harness([tenantId]);
    await run(morningOf("2026-09-30"));
    await admin.query(
      "UPDATE usage_periods SET billable_seconds = 900 * 60 WHERE tenant_id = $1 AND period_start = '2026-08-31'",
      [tenantId],
    );
    await run(morningOf("2026-10-01"));
    expect((await charges(tenantId))[0]).toMatchObject({
      billable_seconds: 100,
      total_pence: 9900,
    });
    expect(payments.payments).toHaveLength(1);
  });
});
