// Retention's edges (BUILD_PLAN Appendix D: recordings 30 days, transcripts, summaries and
// extracted fields 12 months). The periods are counted in UK days and months, so the cut-off
// moves by an hour across a clock change; CLAUDE.md asks for those weekends to be tested.
// retention.test.ts covers the ordinary runs. Like it, this file runs retention across every
// business, so it checks its own rows only.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminPool, createTenant } from "../db/cross-tenant.ts";
import { FakeTelephonyProvider } from "../providers/telephony.fake.ts";
import { FakeVoiceProvider } from "../providers/voice.fake.ts";
import { TEST_ADMIN_DATABASE_URL } from "../testing/databases.ts";
import { runRetention } from "./retention.ts";

const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);

// Retention sweeps every business, so this file and retention.test.ts take turns: run side
// by side, one's sweep would take the other's rows before its own run could count them. The
// same advisory lock in both, held for the file's whole run.
const RETENTION_FILES_LOCK = 4_720_031;
let turn: pg.Client;
beforeAll(async () => {
  turn = new pg.Client({ connectionString: TEST_ADMIN_DATABASE_URL });
  await turn.connect();
  await turn.query("SELECT pg_advisory_lock($1)", [RETENTION_FILES_LOCK]);
}, 120_000);

/** Rows this file leaves undeletable on purpose, removed so later sweeps don't count them. */
const leftovers: string[] = [];

afterAll(async () => {
  await admin.query("DELETE FROM calls WHERE id = ANY($1)", [leftovers]);
  await admin.end();
  await turn.query("SELECT pg_advisory_unlock($1)", [RETENTION_FILES_LOCK]);
  await turn.end();
});

async function seedCall(tenantId: string, startedAt: string, recordingRef?: string) {
  const providerCallId = `call_${randomUUID()}`;
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO calls (tenant_id, provider_call_id, caller_number, started_at, ended_at,
                        billable_seconds, urgency, flags, transcript, summary, extracted_fields,
                        recording_ref, via_fallback)
     VALUES ($1, $2, '+447700900951', $3, $3, 95, 'urgent', '{price-mentioned}', 'agent: hi',
             'Summary.', '{"callerName":"Sam","postcode":"XQ5 1AA"}', $4, $5)
     RETURNING id`,
    [
      tenantId,
      providerCallId,
      startedAt,
      recordingRef ?? `https://recordings.example/${providerCallId}`,
      recordingRef !== undefined,
    ],
  );
  return { callId: rows[0]!.id, providerCallId };
}

const state = async (callId: string) =>
  (
    await admin.query(
      `SELECT recording_ref IS NOT NULL AS recording, transcript IS NOT NULL AS transcript,
              summary IS NOT NULL AS summary, extracted_fields <> '{}' AS fields
       FROM calls WHERE id = $1`,
      [callId],
    )
  ).rows[0] as { recording: boolean; transcript: boolean; summary: boolean; fields: boolean };

const run = (
  now: string,
  voice = new FakeVoiceProvider(),
  telephony = new FakeTelephonyProvider(),
) => runRetention({ admin, voice, telephony, now: () => new Date(now) });

describe("the recording cut-off", () => {
  it("is 30 UK days back, so across October's clock change it sits an hour off 30 × 24 hours", async () => {
    // Noon GMT on 6 November; 30 UK days earlier is noon BST on 7 October, which is 11:00 UTC.
    // A cut-off of 30 × 24 hours would be 12:00 UTC and would take the 11:30 call too soon.
    const tenant = await createTenant(admin, {
      businessName: "Cut-off Plumbing",
      trade: "plumber",
    });
    const justOver = await seedCall(tenant, "2026-10-07T10:59:59.999Z");
    const exactly = await seedCall(tenant, "2026-10-07T11:00:00.000Z");
    const halfPast = await seedCall(tenant, "2026-10-07T11:30:00.000Z");
    const voice = new FakeVoiceProvider();
    await run("2026-11-06T12:00:00Z", voice);
    expect((await state(justOver.callId)).recording).toBe(false);
    expect((await state(exactly.callId)).recording).toBe(true);
    expect((await state(halfPast.callId)).recording).toBe(true);
    expect(voice.deleteCalls).toContain(justOver.providerCallId);
    expect(voice.deleteCalls).not.toContain(halfPast.providerCallId);
  });

  it("deletes only the recording at 30 days: the transcript, summary and fields stay", async () => {
    const tenant = await createTenant(admin, {
      businessName: "Only Audio Plumbing",
      trade: "plumber",
    });
    const call = await seedCall(tenant, "2026-09-01T09:00:00Z");
    await run("2026-11-06T12:00:00Z");
    expect(await state(call.callId)).toEqual({
      recording: false,
      transcript: true,
      summary: true,
      fields: true,
    });
  });
});

describe("the transcript cut-off", () => {
  it("is 12 UK months back, even when that lands in the hour the clocks skipped", async () => {
    // 01:30 BST on 30 March 2026; 12 months earlier is 01:30 on 30 March 2025, an hour that
    // never happened in the UK (clocks went 01:00 GMT → 02:00 BST). Counted forward, it's
    // 02:30 BST, which is 01:30 UTC.
    const tenant = await createTenant(admin, {
      businessName: "Gap Hour Plumbing",
      trade: "plumber",
    });
    const before = await seedCall(tenant, "2025-03-30T01:29:59.999Z");
    const at = await seedCall(tenant, "2025-03-30T01:30:00.000Z");
    await run("2026-03-30T00:30:00Z");
    expect(await state(before.callId)).toMatchObject({
      transcript: false,
      summary: false,
      fields: false,
    });
    expect(await state(at.callId)).toMatchObject({ transcript: true, summary: true, fields: true });
  });

  it("clears the content and keeps the record of the call: when, how long, how urgent, the flags", async () => {
    const tenant = await createTenant(admin, {
      businessName: "Kept Record Plumbing",
      trade: "plumber",
    });
    const call = await seedCall(tenant, "2024-01-15T09:00:00Z");
    await run("2026-11-06T12:00:00Z");
    const { rows } = await admin.query(
      `SELECT transcript, summary, extracted_fields, recording_ref, caller_number,
              billable_seconds, urgency, flags, started_at
       FROM calls WHERE id = $1`,
      [call.callId],
    );
    expect(rows[0]).toEqual({
      transcript: null,
      summary: null,
      extracted_fields: {},
      recording_ref: null,
      caller_number: "+447700900951",
      billable_seconds: 95,
      urgency: "urgent",
      flags: ["price-mentioned"],
      started_at: new Date("2024-01-15T09:00:00Z"),
    });
  });
});

describe("a recording that can't be deleted", () => {
  it("keeps a fallback recording whose reference has no recording ID, and asks nobody to delete it", async () => {
    // Clearing the row without deleting at Twilio would leave the audio there for good.
    const tenant = await createTenant(admin, {
      businessName: "Odd Ref Plumbing",
      trade: "plumber",
    });
    const call = await seedCall(tenant, "2026-08-01T09:00:00Z", "https://api.twilio.com/odd");
    leftovers.push(call.callId);
    const telephony = new FakeTelephonyProvider();
    const voice = new FakeVoiceProvider();
    const counts = await run("2026-11-06T12:00:00Z", voice, telephony);
    expect(counts.recordingsFailed).toBeGreaterThanOrEqual(1);
    expect((await state(call.callId)).recording).toBe(true);
    expect(voice.deleteCalls).not.toContain(call.providerCallId);
  });
});
