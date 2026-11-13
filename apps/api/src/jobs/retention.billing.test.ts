// Billing records in the nightly retention run (jobs/retention.ts, db/cross-tenant.ts
// deleteOldBillingRecords): kept 7 years from the end of each billing month, then deleted, and
// nothing still running is touched. Real Postgres. The records are dated in the 2010s, which no
// other test uses, and this file takes turns with the other retention tests (they sweep every
// business too).
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminPool, createTenant } from "../db/cross-tenant.ts";
import { createPool } from "../db/pool.ts";
import { withTenant } from "../db/tenant.ts";
import { FakeTelephonyProvider } from "../providers/telephony.fake.ts";
import { FakeVoiceProvider } from "../providers/voice.fake.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import { runRetention } from "./retention.ts";

const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);
const app = createPool(TEST_DATABASE_URL);

// The same lock as retention.test.ts and retention.boundaries.test.ts: one file's sweep would
// otherwise take another's rows.
const RETENTION_FILES_LOCK = 4_720_031;
let turn: pg.Client;
beforeAll(async () => {
  turn = new pg.Client({ connectionString: TEST_ADMIN_DATABASE_URL });
  await turn.connect();
  await turn.query("SELECT pg_advisory_lock($1)", [RETENTION_FILES_LOCK]);
}, 120_000);

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
  await turn.query("SELECT pg_advisory_unlock($1)", [RETENTION_FILES_LOCK]);
  await turn.end();
});

/** 06:00 on 6 November 2026, UK time: so anything that ended on or before 6 November 2019 goes. */
const NOW = new Date("2026-11-06T06:00:00Z");

const run = () =>
  runRetention({
    admin,
    voice: new FakeVoiceProvider(),
    telephony: new FakeTelephonyProvider(),
    now: () => NOW,
  });

async function charge(tenantId: string, periodStart: string, periodEnd: string) {
  await withTenant(app, tenantId, async (client) => {
    await client.query(
      `INSERT INTO billing_charges (tenant_id, period_start, period_end, period_index,
         billable_seconds, fee_pence, overage_minutes, overage_pence, vat_rate_percent,
         vat_pence, total_pence, lines, status)
       VALUES ($1, $2, $3, 0, 0, 9900, 0, 0, 0, 0, 9900, '[]', 'paid_out')`,
      [tenantId, periodStart, periodEnd],
    );
    await client.query(
      `INSERT INTO usage_periods (tenant_id, period_start, period_end, billable_seconds)
       VALUES ($1, $2, $3, 600)`,
      [tenantId, periodStart, periodEnd],
    );
  });
}

const left = async (table: string, tenantId: string, column: string) =>
  (
    await admin.query<{ value: string }>(
      `SELECT ${column}::text AS value FROM ${table} WHERE tenant_id = $1 ORDER BY 1`,
      [tenantId],
    )
  ).rows.map((row) => row.value);

describe("billing records in the nightly retention run", () => {
  it("deletes each month's charge and usage 7 years after the month ended, and keeps the rest", async () => {
    const tenantId = await createTenant(admin, { businessName: "Old Plumbing", trade: "plumber" });
    // Ended 6 October 2019 and 6 November 2019 (the last day the 5th): both 7 years gone today.
    await charge(tenantId, "2019-09-06", "2019-10-06");
    await charge(tenantId, "2019-10-06", "2019-11-06");
    // Ends 6 December 2019: still inside its 7 years.
    await charge(tenantId, "2019-11-06", "2019-12-06");

    const counts = await run();
    expect(await left("billing_charges", tenantId, "period_start")).toEqual(["2019-11-06"]);
    expect(await left("usage_periods", tenantId, "period_start")).toEqual(["2019-11-06"]);
    expect(counts.billingRecordsDeleted).toBeGreaterThanOrEqual(4);
  });

  it("deletes emails, payment events, ended Direct Debits and ended suspensions by their own date", async () => {
    const tenantId = await createTenant(admin, {
      businessName: "Old Sparks",
      trade: "electrician",
    });
    await withTenant(app, tenantId, async (client) => {
      await client.query(
        `INSERT INTO billing_emails (tenant_id, kind, ref, status, created_at) VALUES
           ($1, 'receipt', 'charge-old', 'sent', '2019-11-05T06:00:00Z'),
           ($1, 'receipt', 'charge-new', 'sent', '2019-11-07T06:00:00Z')`,
        [tenantId],
      );
      await client.query(
        `INSERT INTO payment_events (event_id, tenant_id, resource_type, action, received_at) VALUES
           ('EV_old_${tenantId}', $1, 'payments', 'paid_out', '2019-01-10T10:00:00Z'),
           ('EV_new_${tenantId}', $1, 'payments', 'paid_out', '2020-01-10T10:00:00Z')`,
        [tenantId],
      );
      await client.query(
        `INSERT INTO payment_mandates (tenant_id, setup_ref, authorisation_url, expires_at,
           mandate_ref, status, activated_at, ended_at, created_at) VALUES
           -- Ended in 2019: gone. Ended in 2020: kept. Active since 2018: always kept.
           ($1, 'BRQ_old_${tenantId}', 'https://pay.example.com/a', '2018-01-08T00:00:00Z',
            'MD_old_${tenantId}', 'cancelled', '2018-01-02T00:00:00Z', '2019-01-02T00:00:00Z', '2018-01-01T00:00:00Z'),
           ($1, 'BRQ_mid_${tenantId}', 'https://pay.example.com/b', '2019-02-08T00:00:00Z',
            'MD_mid_${tenantId}', 'cancelled', '2019-02-02T00:00:00Z', '2020-01-02T00:00:00Z', '2019-02-01T00:00:00Z'),
           ($1, 'BRQ_live_${tenantId}', 'https://pay.example.com/c', '2018-03-08T00:00:00Z',
            'MD_live_${tenantId}', 'active', '2018-03-02T00:00:00Z', NULL, '2018-03-01T00:00:00Z')`,
        [tenantId],
      );
      await client.query(
        `INSERT INTO tenant_suspensions (tenant_id, started_at, ended_at) VALUES
           ($1, '2018-06-01T00:00:00Z', '2019-01-01T00:00:00Z'),
           ($1, '2019-06-01T00:00:00Z', '2020-01-01T00:00:00Z')`,
        [tenantId],
      );
    });

    await run();
    expect(await left("billing_emails", tenantId, "ref")).toEqual(["charge-new"]);
    expect(await left("payment_events", tenantId, "event_id")).toEqual([`EV_new_${tenantId}`]);
    expect(await left("payment_mandates", tenantId, "mandate_ref")).toEqual([
      `MD_live_${tenantId}`,
      `MD_mid_${tenantId}`,
    ]);
    expect(await left("tenant_suspensions", tenantId, "ended_at")).toEqual([
      "2020-01-01 00:00:00+00",
    ]);
  });

  it("never deletes a suspension that hasn't ended, however old", async () => {
    const tenantId = await createTenant(admin, { businessName: "Still Paused", trade: "plumber" });
    await withTenant(app, tenantId, (client) =>
      client.query(
        "INSERT INTO tenant_suspensions (tenant_id, started_at) VALUES ($1, '2015-01-01T00:00:00Z')",
        [tenantId],
      ),
    );
    await run();
    expect(await left("tenant_suspensions", tenantId, "started_at")).toEqual([
      "2015-01-01 00:00:00+00",
    ]);
  });

  it("deletes nothing the second time round", async () => {
    await run();
    expect((await run()).billingRecordsDeleted).toBe(0);
  });
});
