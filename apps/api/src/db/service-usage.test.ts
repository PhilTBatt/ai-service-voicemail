// What the Admin page's Costs tab reads from the database (db/cross-tenant.ts): each business
// costed over its own billing month beside its bill so far, and the last 30 days' use of every
// supplier against the 30 before. Real Postgres. The windows are years away from any other
// test's data, because these counts span every business.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import {
  createAdminPool,
  createTenant,
  estimateMonthCosts,
  readServiceUsage,
} from "./cross-tenant.ts";
import { createPool } from "./pool.ts";
import { withTenant } from "./tenant.ts";

const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);

afterAll(async () => {
  await Promise.all([app.end(), admin.end()]);
});

const PRICES = {
  gbpPerUsd: "0.8",
  smsSegmentGbp: "0.042325",
  inboundCallPerMinuteGbp: "0.007558",
  sipPerMinuteUsd: "0.004",
  transcriptionPerMinuteUsd: "0.024",
  localNumberPerMonthGbp: "0.86917",
  models: {},
};

async function business(
  name: string,
  set: { status?: string; anchor?: string | null; isTest?: boolean; isPilot?: boolean } = {},
) {
  const tenantId = await createTenant(admin, { businessName: name, trade: "plumber" });
  await admin.query(
    "UPDATE tenants SET status = $2, billing_start_date = $3, is_test = $4, is_pilot = $5 WHERE id = $1",
    [tenantId, set.status ?? "live", set.anchor ?? null, set.isTest ?? false, set.isPilot ?? false],
  );
  return tenantId;
}

async function call(tenantId: string, startedAt: string, seconds: number, usdCents = 0) {
  const id = (
    await admin.query<{ id: string }>(
      `INSERT INTO calls (tenant_id, provider_call_id, started_at, ended_at, billable_seconds)
       VALUES ($1, $2, $3, $3::timestamptz + make_interval(secs => $4), $4) RETURNING id`,
      [tenantId, `call_${randomUUID()}`, startedAt, seconds],
    )
  ).rows[0]!.id;
  if (usdCents > 0) {
    await admin.query(
      `INSERT INTO call_costs (tenant_id, call_id, component, units, unit_type, is_estimated)
       VALUES ($1, $2, 'retell:llm', $3, 'usd_cents', false)`,
      [tenantId, id, usdCents],
    );
  }
  return id;
}

const usagePeriod = (tenantId: string, start: string, end: string, seconds: number) =>
  admin.query(
    "INSERT INTO usage_periods (tenant_id, period_start, period_end, billable_seconds) VALUES ($1, $2, $3, $4)",
    [tenantId, start, end, seconds],
  );

describe("estimateMonthCosts", () => {
  const now = new Date("2037-03-20T12:00:00Z");

  it("costs a live business over its own billing month, beside its bill so far", async () => {
    const tenantId = await business("Month Plumbing", { anchor: "2037-01-14" });
    // Its month is 14 March to 13 April: the call on the 10th is last month's, the one on the
    // 15th this month's, though both are in the calendar month.
    await call(tenantId, "2037-03-10T10:00:00Z", 600, 1000);
    await call(tenantId, "2037-03-15T10:00:00Z", 120, 50);
    // 12,630 seconds this month: 211 minutes, 11 over the 200 at 20p.
    await usagePeriod(tenantId, "2037-03-14", "2037-04-14", 12630);

    const { calendar, tenants } = await estimateMonthCosts(admin, now, PRICES);
    expect(calendar).toEqual({ periodStart: "2037-03-01", periodEnd: "2037-04-01" });
    expect(tenants.find((row) => row.tenantId === tenantId)).toMatchObject({
      windowStart: "2037-03-14",
      windowEnd: "2037-04-14",
      calls: 1,
      callSeconds: 120,
      // 50 US cents at 0.8.
      pence: { voicePlatform: 40 },
      billPence: 9900 + 220,
    });
  });

  it("costs a business that isn't live over the calendar month, with no bill", async () => {
    const tenantId = await business("Waiting Plumbing", { status: "onboarding" });
    await call(tenantId, "2037-03-10T10:00:00Z", 60, 100);
    await call(tenantId, "2037-02-27T10:00:00Z", 60, 100);
    const { tenants } = await estimateMonthCosts(admin, now, PRICES);
    expect(tenants.find((row) => row.tenantId === tenantId)).toMatchObject({
      windowStart: "2037-03-01",
      windowEnd: "2037-04-01",
      calls: 1,
      pence: { voicePlatform: 80 },
      billPence: null,
    });
  });

  it("gives no bill to the demo line or a test business, and the pilot's fee to a pilot", async () => {
    const demo = await business("Demo Line", { status: "demo", anchor: "2037-01-14" });
    const test = await business("Test Plumbing", { anchor: "2037-01-14", isTest: true });
    const pilot = await business("Pilot Plumbing", { anchor: "2037-03-14", isPilot: true });
    const { tenants } = await estimateMonthCosts(admin, now, PRICES);
    const row = (tenantId: string) => tenants.find((each) => each.tenantId === tenantId);
    expect(row(demo)).toMatchObject({ billPence: null, windowStart: "2037-03-01" });
    // A test business has a billing month, so it's costed over it, but it never pays.
    expect(row(test)).toMatchObject({ billPence: null, windowStart: "2037-03-14" });
    // The pilot's first month is free.
    expect(row(pilot)).toMatchObject({ billPence: 0, windowStart: "2037-03-14" });
  });

  it("gives no bill for a month that began after the business left", async () => {
    const tenantId = await business("Gone Plumbing", { anchor: "2037-01-14" });
    await admin.query(
      "UPDATE tenants SET status = 'cancelling', cancellation_requested_at = '2037-03-01T10:00:00Z' WHERE id = $1",
      [tenantId],
    );
    const { tenants } = await estimateMonthCosts(admin, now, PRICES);
    expect(tenants.find((row) => row.tenantId === tenantId)?.billPence).toBeNull();
  });
});

describe("readServiceUsage", () => {
  it("counts the last 30 days and the 30 before: calls, calls at once, emails, texts, payments", async () => {
    const now = new Date("2041-06-30T12:00:00Z");
    const tenantId = await business("Busy Plumbing", { anchor: "2041-01-01" });

    // The last 30 days (31 May 12:00 to 30 June 12:00): three calls overlapping at 10:02 on
    // the 10th, and one alone on the 20th.
    const first = await call(tenantId, "2041-06-10T10:00:00Z", 300, 100);
    const second = await call(tenantId, "2041-06-10T10:01:00Z", 300);
    await call(tenantId, "2041-06-10T10:02:00Z", 60);
    await call(tenantId, "2041-06-20T09:00:00Z", 90);
    // The 30 before: one call.
    const earlier = await call(tenantId, "2041-05-10T10:00:00Z", 600, 200);
    // Too old for either window.
    await call(tenantId, "2041-04-01T10:00:00Z", 600, 5000);

    await withTenant(app, tenantId, async (client) => {
      // Emails: two call emails sent (one since delivered), one that failed (not counted).
      await client.query(
        `INSERT INTO notifications (tenant_id, call_id, channel, status, created_at) VALUES
           ($1, $2, 'email', 'sent', '2041-06-10T10:06:00Z'),
           ($1, $3, 'email', 'delivered', '2041-06-10T10:07:00Z'),
           ($1, $4, 'email', 'sent', '2041-05-10T10:11:00Z')`,
        [tenantId, first, second, earlier],
      );
      await client.query(
        `INSERT INTO offboarding_messages (tenant_id, kind, channel, status, segments, created_at) VALUES
           ($1, 'cancellation', 'email', 'sent', NULL, '2041-06-21T10:00:00Z'),
           ($1, 'cancellation', 'sms', 'sent', 3, '2041-06-21T10:00:00Z')`,
        [tenantId],
      );
      await client.query(
        `INSERT INTO onboarding_texts (tenant_id, kind, status, segments, created_at)
         VALUES ($1, 'go_live', 'sent', 2, '2041-06-02T10:00:00Z')`,
        [tenantId],
      );
      // Call texts: 4 segments in the last 30 days.
      await client.query(
        `INSERT INTO call_costs (tenant_id, call_id, component, units, unit_type, is_estimated)
         VALUES ($1, $2, 'sms:segments', 4, 'segments', false)`,
        [tenantId, first],
      );
      // A receipt email, and the payment it was for; a month with nothing due has no payment.
      await client.query(
        `INSERT INTO billing_emails (tenant_id, kind, ref, status, created_at)
         VALUES ($1, 'receipt', $2, 'sent', '2041-06-02T06:00:00Z')`,
        [tenantId, randomUUID()],
      );
      await client.query(
        `INSERT INTO billing_charges (tenant_id, period_start, period_end, period_index,
           billable_seconds, fee_pence, overage_minutes, overage_pence, vat_rate_percent,
           vat_pence, total_pence, lines, status, payment_ref, created_at) VALUES
           ($1, '2041-05-01', '2041-06-01', 4, 0, 9900, 0, 0, 0, 0, 9900, '[]', 'pending', $2, '2041-06-02T06:00:00Z'),
           ($1, '2041-04-01', '2041-05-01', 3, 0, 0, 0, 0, 0, 0, 0, '[]', 'nothing_due', NULL, '2041-06-02T06:00:00Z')`,
        [tenantId, `PM${randomUUID()}`],
      );
    });

    const usage = await readServiceUsage(admin, now, PRICES);
    expect(usage.from).toEqual(new Date("2041-05-31T12:00:00Z"));
    expect(usage.last).toMatchObject({
      calls: 4,
      callSeconds: 750,
      peakConcurrentCalls: 3,
      // Two call emails, the cancellation email and the receipt.
      emails: 4,
      // 4 for the call, 3 for the cancellation text, 2 for the going-live text.
      textSegments: 9,
      payments: [9900],
    });
    // 100 US cents at 0.8; 9 segments at 4.2325p is 38.09p, split 17p call texts + 21p account.
    expect(usage.last.pence).toMatchObject({ voicePlatform: 80, texts: 17 + 21 });
    expect(usage.previous).toMatchObject({
      calls: 1,
      callSeconds: 600,
      peakConcurrentCalls: 1,
      emails: 1,
      textSegments: 0,
      payments: [],
    });
    expect(usage.previous.pence.voicePlatform).toBe(160);
    expect(usage.logins).toBeGreaterThanOrEqual(0);
    expect(usage.activeNumbers).toBeGreaterThanOrEqual(0);
  });
});
