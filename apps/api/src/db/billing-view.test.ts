// What a business sees of its billing (db/billing.ts): the month it's in, counted in UK time
// from the day it went live; the pilot's fee for that month; nothing to come once it has left;
// its last twelve charges, newest first, and never another business's. Real Postgres.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import { loadBillingView } from "./billing.ts";
import { createAdminPool, createTenant } from "./cross-tenant.ts";
import { createPool } from "./pool.ts";
import { withTenant } from "./tenant.ts";

const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);

afterAll(async () => {
  await Promise.all([app.end(), admin.end()]);
});

interface BusinessOptions {
  anchor?: string | null;
  isPilot?: boolean;
  status?: string;
  leftAt?: string | null;
}

async function business({
  anchor = "2026-09-14",
  isPilot = false,
  status = "live",
  leftAt = null,
}: BusinessOptions = {}) {
  const tenantId = await createTenant(admin, { businessName: "View Plumbing", trade: "plumber" });
  await admin.query(
    `UPDATE tenants SET status = $2, is_pilot = $3, billing_start_date = $4,
            cancellation_requested_at = $5 WHERE id = $1`,
    [tenantId, status, isPilot, anchor, leftAt],
  );
  return tenantId;
}

const view = (tenantId: string, now: string) =>
  loadBillingView(app, tenantId, { now: new Date(now), available: true });

async function addCharge(tenantId: string, periodStart: string, total = 9900) {
  await withTenant(app, tenantId, (client) =>
    client.query(
      `INSERT INTO billing_charges (tenant_id, period_start, period_end, period_index,
         billable_seconds, fee_pence, overage_minutes, overage_pence, vat_rate_percent,
         vat_pence, total_pence, lines, status)
       VALUES ($1, $2, ($2::date + interval '1 month')::date, 0, 0, $3, 0, 0, 0, 0, $3, '[]', 'paid_out')`,
      [tenantId, periodStart, total],
    ),
  );
}

describe("the month a business is in", () => {
  it("counts months from going live, with the month's billable time so far", async () => {
    const tenantId = await business();
    await admin.query(
      `INSERT INTO usage_periods (tenant_id, period_start, period_end, billable_seconds)
       VALUES ($1, '2026-11-14', '2026-12-14', 4321)`,
      [tenantId],
    );
    expect((await view(tenantId, "2026-11-20T12:00:00Z"))?.period).toEqual({
      start: "2026-11-14",
      end: "2026-12-14",
      month: 3,
      feePence: 9900,
      billableSeconds: 4321,
      // 73 minutes of the 200 included: just the fee.
      soFar: { overageMinutes: 0, overagePence: 0, totalPence: 9900 },
      // Day 7 of 30: 4,321 s x 30 / 7 = 18,519 s, 309 minutes, 109 over at 20p.
      projected: { minutes: 309, overagePence: 2180, totalPence: 12080 },
      days: [14, 15, 16, 17, 18, 19, 20].map((day) => ({
        date: `2026-11-${day}`,
        billableSeconds: 0,
      })),
    });
  });

  it("shows the bill so far with extra minutes, where it's heading, and each day's minutes", async () => {
    const tenantId = await business();
    const call = (startedAt: string, seconds: number) =>
      admin.query(
        `INSERT INTO calls (tenant_id, provider_call_id, started_at, ended_at, billable_seconds)
         VALUES ($1, $2, $3, $3::timestamptz + make_interval(secs => $4), $4)`,
        [tenantId, `call_${randomUUID()}`, startedAt, seconds],
      );
    // One call the night before the month starts (not this month's), two on the 14th and one
    // on the 16th. November is winter, so UK time is UTC.
    await call("2026-11-13T23:59:00Z", 500);
    await call("2026-11-14T00:30:00Z", 6000);
    await call("2026-11-14T15:00:00Z", 3000);
    await call("2026-11-16T09:00:00Z", 3630);
    await admin.query(
      `INSERT INTO usage_periods (tenant_id, period_start, period_end, billable_seconds)
       VALUES ($1, '2026-11-14', '2026-12-14', 12630)`,
      [tenantId],
    );
    const period = (await view(tenantId, "2026-11-16T12:00:00Z"))?.period;
    // 12,630 s is 210.5 minutes: rounded up once to 211, 11 over the 200, at 20p.
    expect(period?.soFar).toEqual({ overageMinutes: 11, overagePence: 220, totalPence: 10120 });
    // Day 3: too early to say where the month is heading.
    expect(period?.projected).toBeNull();
    expect(period?.days).toEqual([
      { date: "2026-11-14", billableSeconds: 9000 },
      { date: "2026-11-15", billableSeconds: 0 },
      { date: "2026-11-16", billableSeconds: 3630 },
    ]);
    expect(period?.days.reduce((total, day) => total + day.billableSeconds, 0)).toBe(12630);
  });

  it("leaves the go-live day's test call out of the days, as it's left out of the bill", async () => {
    const tenantId = await business({ anchor: "2026-11-14" });
    // A 90-second test call before going live that day (stored, never billed), then a real one.
    await admin.query(
      `INSERT INTO calls (tenant_id, provider_call_id, started_at, ended_at, billable_seconds)
       VALUES ($1, $2, '2026-11-14T09:00:00Z', '2026-11-14T09:01:30Z', 90),
              ($1, $3, '2026-11-14T16:00:00Z', '2026-11-14T16:02:00Z', 120)`,
      [tenantId, `call_${randomUUID()}`, `call_${randomUUID()}`],
    );
    await admin.query(
      `INSERT INTO usage_periods (tenant_id, period_start, period_end, billable_seconds)
       VALUES ($1, '2026-11-14', '2026-12-14', 120)`,
      [tenantId],
    );
    expect((await view(tenantId, "2026-11-14T18:00:00Z"))?.period?.days).toEqual([
      { date: "2026-11-14", billableSeconds: 120 },
    ]);
  });

  it("shows the first month when this server's clock is a moment behind the database's on go-live day", async () => {
    // The database dated going live 11 November (its clock just past UK midnight); this
    // server's clock still says 10 November. Before, that was an error, and the page a 500.
    const tenantId = await business({ anchor: "2026-11-11" });
    expect((await view(tenantId, "2026-11-10T23:59:59.900Z"))?.period).toEqual({
      start: "2026-11-11",
      end: "2026-12-11",
      month: 1,
      feePence: 9900,
      billableSeconds: 0,
      soFar: { overageMinutes: 0, overagePence: 0, totalPence: 9900 },
      projected: null,
      // This server's "today" is the day before the month starts: no days yet.
      days: [],
    });
  });

  it("turns over at UK midnight, which is 23:00 UTC in summer", async () => {
    const tenantId = await business();
    expect((await view(tenantId, "2026-10-13T22:59:59Z"))?.period).toMatchObject({
      start: "2026-09-14",
      month: 1,
    });
    expect((await view(tenantId, "2026-10-13T23:00:00Z"))?.period).toMatchObject({
      start: "2026-10-14",
      month: 2,
      billableSeconds: 0,
    });
  });

  it("follows a 31st anchor through February", async () => {
    const tenantId = await business({ anchor: "2027-01-31" });
    expect((await view(tenantId, "2027-02-28T12:00:00Z"))?.period).toMatchObject({
      start: "2027-02-28",
      end: "2027-03-31",
      month: 2,
    });
    expect((await view(tenantId, "2027-02-27T12:00:00Z"))?.period).toMatchObject({
      start: "2027-01-31",
      end: "2027-02-28",
      month: 1,
    });
  });

  it("shows the pilot's fee for the month it's in", async () => {
    const tenantId = await business({ isPilot: true });
    const fees = [];
    for (const now of [
      "2026-09-20T12:00:00Z",
      "2026-10-20T12:00:00Z",
      "2026-12-20T12:00:00Z",
      "2027-01-20T12:00:00Z",
    ]) {
      fees.push((await view(tenantId, now))?.period?.feePence);
    }
    expect(fees).toEqual([0, 4900, 4900, 9900]);
    expect((await view(tenantId, "2026-09-20T12:00:00Z"))?.isPilot).toBe(true);
  });

  it("shows no month to be charged for the demo line or a business not yet live", async () => {
    const demo = await business({ status: "demo" });
    const onboarding = await business({ anchor: null, status: "onboarding" });
    for (const tenantId of [demo, onboarding]) {
      expect((await view(tenantId, "2026-11-20T12:00:00Z"))?.period).toBeNull();
    }
  });

  it("shows the plan's own prices", async () => {
    expect((await view(await business(), "2026-11-20T12:00:00Z"))?.plan).toEqual({
      name: "AI Answering",
      monthlyPence: 9900,
      includedMinutes: 200,
      overagePencePerMinute: 20,
    });
  });

  it("finds nothing for a business that doesn't exist", async () => {
    expect(await view(randomUUID(), "2026-11-20T12:00:00Z")).toBeNull();
  });
});

describe("a business that has left", () => {
  it("shows the month it left in, and no month after, by its UK date", async () => {
    // Asked to leave at 00:30 BST on 14 October (23:30 UTC on the 13th): the UK date is the
    // 14th, the first day of its second month, which therefore isn't charged.
    const tenantId = await business({ status: "cancelling", leftAt: "2026-10-13T23:30:00Z" });
    const leftInFirst = await view(tenantId, "2026-10-13T23:45:00Z");
    expect(leftInFirst?.leftOn).toBe("2026-10-14");
    expect(leftInFirst?.period).toBeNull();
    expect((await view(tenantId, "2026-10-13T22:00:00Z"))?.period).toMatchObject({
      start: "2026-09-14",
    });

    // Asked a day later: the second month began before it asked, so it's still shown.
    const later = await business({ status: "cancelling", leftAt: "2026-10-14T23:30:00Z" });
    const view2 = await view(later, "2026-10-20T12:00:00Z");
    expect(view2?.leftOn).toBe("2026-10-15");
    expect(view2?.period).toMatchObject({ start: "2026-10-14", month: 2 });
    expect((await view(later, "2026-11-20T12:00:00Z"))?.period).toBeNull();
  });
});

describe("charges", () => {
  it("lists the last twelve, newest first, and only the business's own", async () => {
    // No billing start date: the morning run in charge-periods.test.ts, which may run alongside
    // this file, charges every live business with ended months, and would collide with these.
    const tenantId = await business({ anchor: null, status: "paused" });
    const other = await business({ anchor: null, status: "paused" });
    const starts = Array.from({ length: 14 }, (_, i) =>
      Temporal.PlainDate.from("2025-08-14").add({ months: i }).toString(),
    );
    for (const [i, start] of starts.entries()) await addCharge(tenantId, start, 9900 + i);
    await addCharge(other, "2026-09-14", 1);

    const charges = (await view(tenantId, "2026-11-20T12:00:00Z"))?.charges ?? [];
    expect(charges.map((c) => c.periodStart)).toEqual(starts.slice(2).reverse());
    expect(charges.map((c) => c.totalPence)).toEqual(
      starts
        .map((_, i) => 9900 + i)
        .slice(2)
        .reverse(),
    );
    expect(
      charges.every((c) => Number.isInteger(c.totalPence) && Number.isInteger(c.vatPence)),
    ).toBe(true);
    expect((await view(other, "2026-11-20T12:00:00Z"))?.charges.map((c) => c.totalPence)).toEqual([
      1,
    ]);
  });

  it("shows a business with no Direct Debit as having none", async () => {
    expect((await view(await business(), "2026-11-20T12:00:00Z"))?.directDebit).toEqual({
      status: "none",
      since: null,
      endReason: null,
    });
  });
});
