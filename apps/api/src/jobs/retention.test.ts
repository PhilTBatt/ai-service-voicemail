import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AlertName } from "../alerts.ts";
import {
  RECORDING_BATCH_SIZE,
  clearExpiredTranscripts,
  createAdminPool,
  createTenant,
} from "../db/cross-tenant.ts";
import { FakeTelephonyProvider } from "../providers/telephony.fake.ts";
import { FakeVoiceProvider } from "../providers/voice.fake.ts";
import { TEST_ADMIN_DATABASE_URL } from "../testing/databases.ts";
import { runRetention } from "./retention.ts";

const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);
const NOW = new Date("2026-11-06T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const daysFrom = (from: Date, days: number) => new Date(from.getTime() + days * 86_400_000);

// Retention sweeps every business, so this file and retention.boundaries.test.ts take turns:
// run side by side, one's sweep would take the other's rows before its own run counted them.
const RETENTION_FILES_LOCK = 4_720_031;
let turn: pg.Client;
beforeAll(async () => {
  turn = new pg.Client({ connectionString: TEST_ADMIN_DATABASE_URL });
  await turn.connect();
  await turn.query("SELECT pg_advisory_lock($1)", [RETENTION_FILES_LOCK]);
}, 120_000);

afterAll(async () => {
  await admin.end();
  await turn.query("SELECT pg_advisory_unlock($1)", [RETENTION_FILES_LOCK]);
  await turn.end();
});

interface Seed {
  tenantId: string;
  startedAt: Date;
  viaFallback?: boolean;
  recording?: boolean;
}

async function seedCall({ tenantId, startedAt, viaFallback = false, recording = true }: Seed) {
  const providerCallId = `call_${randomUUID()}`;
  const recordingRef = !recording
    ? null
    : viaFallback
      ? `https://api.twilio.com/2010-04-01/Accounts/AC0/Recordings/RE${randomUUID().replace(/-/g, "")}`
      : `https://recordings.example/${providerCallId}`;
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO calls (tenant_id, provider_call_id, started_at, ended_at, transcript, summary,
                        extracted_fields, recording_ref, via_fallback)
     VALUES ($1, $2, $3, $3, 'agent: hi', 'Summary.', '{"callerName":"Sam"}', $4, $5) RETURNING id`,
    [tenantId, providerCallId, startedAt, recordingRef, viaFallback],
  );
  return { callId: rows[0]!.id, providerCallId, recordingRef };
}

const callState = async (callId: string) =>
  (
    await admin.query(
      "SELECT recording_ref IS NOT NULL AS has_recording, transcript IS NOT NULL AS has_transcript, summary, extracted_fields FROM calls WHERE id = $1",
      [callId],
    )
  ).rows[0] as Record<string, unknown>;

describe("runRetention", () => {
  it("deletes expired recordings at the provider for every tenant, keeps recent ones, and clears old transcripts", async () => {
    const a = await createTenant(admin, { businessName: "Retain A", trade: "plumber" });
    const b = await createTenant(admin, { businessName: "Retain B", trade: "roofer" });
    const oldA = await seedCall({ tenantId: a, startedAt: daysAgo(31) });
    const oldB = await seedCall({ tenantId: b, startedAt: daysAgo(45), viaFallback: true });
    const recent = await seedCall({ tenantId: a, startedAt: daysAgo(29) });
    const ancient = await seedCall({ tenantId: b, startedAt: daysAgo(370), recording: false });
    const voice = new FakeVoiceProvider();
    const telephony = new FakeTelephonyProvider();

    const counts = await runRetention({ admin, voice, telephony, now: () => NOW });

    // Other tests' old calls may be swept too, so check this run's rows and the lower bounds.
    expect(counts.recordingsDeleted).toBeGreaterThanOrEqual(2);
    expect(counts.recordingsFailed).toBe(0);
    expect(counts.transcriptsCleared).toBeGreaterThanOrEqual(1);
    expect(voice.deleteCalls).toContain(oldA.providerCallId);
    expect(telephony.deletedRecordings).toContain(/RE[0-9a-f]{32}/.exec(oldB.recordingRef!)![0]);

    expect(await callState(oldA.callId)).toMatchObject({
      has_recording: false,
      has_transcript: true,
    });
    expect(await callState(oldB.callId)).toMatchObject({
      has_recording: false,
      has_transcript: true,
    });
    expect(await callState(recent.callId)).toMatchObject({
      has_recording: true,
      has_transcript: true,
    });
    expect(await callState(ancient.callId)).toEqual({
      has_recording: false,
      has_transcript: false,
      summary: null,
      extracted_fields: {},
    });
  });

  it("keeps the reference when the provider deletion fails, so the next run retries", async () => {
    const t = await createTenant(admin, { businessName: "Retain C", trade: "locksmith" });
    const old = await seedCall({ tenantId: t, startedAt: daysAgo(40) });
    const voice = new FakeVoiceProvider();
    voice.deleteCallData = (id) =>
      id === old.providerCallId ? Promise.reject(new Error("provider down")) : Promise.resolve();

    const counts = await runRetention({
      admin,
      voice,
      telephony: new FakeTelephonyProvider(),
      now: () => NOW,
    });
    expect(counts.recordingsFailed).toBeGreaterThanOrEqual(1);
    expect(await callState(old.callId)).toMatchObject({ has_recording: true });

    // Provider back: the second run clears it.
    voice.deleteCallData = () => Promise.resolve();
    await runRetention({ admin, voice, telephony: new FakeTelephonyProvider(), now: () => NOW });
    expect(await callState(old.callId)).toMatchObject({ has_recording: false });
  });

  it("clears old transcripts a batch at a time, and stops at the batch limit for one run", async () => {
    const t = await createTenant(admin, { businessName: "Retain E", trade: "plumber" });
    // Older than anything another test seeds, so oldest-first makes these the ones batched.
    const seeded = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        seedCall({ tenantId: t, startedAt: daysAgo(10_000 + i) }),
      ),
    );
    const before = daysAgo(365);
    // Two batches of two, then this run's limit: one of the five is left for the next run.
    const firstRun = await clearExpiredTranscripts(admin, before, { batchSize: 2, maxBatches: 2 });
    expect(firstRun).toBeGreaterThanOrEqual(4);
    const states = await Promise.all(seeded.map((call) => callState(call.callId)));
    expect(states.filter((state) => state["has_transcript"] === true).length).toBeLessThanOrEqual(
      1,
    );

    const secondRun = await clearExpiredTranscripts(admin, before, { batchSize: 2 });
    expect(secondRun).toBeGreaterThanOrEqual(0);
    for (const call of seeded) {
      expect(await callState(call.callId)).toMatchObject({ has_transcript: false, summary: null });
    }
  });

  it("moves past a whole batch of recordings that can never be deleted, so newer ones still go", async () => {
    // A batch's worth of fallback references with no Twilio recording ID, older than anything
    // else here. Taken oldest first, 200 at a time, they used to fill every night's batch for
    // good, and the newer recording behind them was never deleted.
    const t = await createTenant(admin, { businessName: "Retain F", trade: "plumber" });
    const stuck = await admin.query<{ id: string }>(
      `INSERT INTO calls (tenant_id, provider_call_id, started_at, ended_at, recording_ref, via_fallback)
       SELECT $1, 'call_stuck_' || $2 || '_' || i, $3::timestamptz - make_interval(days => i),
              $3::timestamptz - make_interval(days => i), 'https://api.twilio.com/odd/' || i, true
       FROM generate_series(1, $4::int) AS i
       RETURNING id`,
      [t, randomUUID(), daysAgo(20_000), RECORDING_BATCH_SIZE],
    );
    const stuckIds = stuck.rows.map((row) => row.id);
    try {
      const behind = await seedCall({ tenantId: t, startedAt: daysAgo(40) });
      const voice = new FakeVoiceProvider();
      const counts = await runRetention({
        admin,
        voice,
        telephony: new FakeTelephonyProvider(),
        now: () => NOW,
        alert: () => undefined,
      });
      expect(counts.recordingsFailed).toBeGreaterThanOrEqual(RECORDING_BATCH_SIZE);
      expect(voice.deleteCalls).toContain(behind.providerCallId);
      expect(await callState(behind.callId)).toMatchObject({ has_recording: false });
      // Each failure is counted on its call, so the next night tries the others first.
      const { rows } = await admin.query<{ attempts: number }>(
        "SELECT DISTINCT recording_delete_attempts AS attempts FROM calls WHERE id = ANY($1)",
        [stuckIds],
      );
      expect(rows).toEqual([{ attempts: 1 }]);
    } finally {
      await admin.query("DELETE FROM calls WHERE id = ANY($1)", [stuckIds]);
    }
  });

  it("alerts once about a recording that can never be deleted, not every night", async () => {
    const t = await createTenant(admin, { businessName: "Retain G", trade: "roofer" });
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO calls (tenant_id, provider_call_id, started_at, ended_at, recording_ref, via_fallback)
       VALUES ($1, $2, $3, $3, 'https://api.twilio.com/no-recording-id', true) RETURNING id`,
      [t, `call_${randomUUID()}`, daysAgo(50)],
    );
    const callId = rows[0]!.id;
    try {
      const raised: { alert: AlertName; details: Record<string, unknown> }[] = [];
      for (let night = 0; night < 4; night++) {
        await runRetention({
          admin,
          voice: new FakeVoiceProvider(),
          telephony: new FakeTelephonyProvider(),
          now: () => daysFrom(NOW, night),
          alert: (alert, details = {}) => {
            if (details["callId"] === callId) raised.push({ alert, details });
          },
        });
      }
      // Said on the first night, since no retry can work; never again for the same recording.
      expect(raised).toEqual([
        {
          alert: "recording-not-deleted",
          details: { tenantId: t, callId, attempts: 1, reason: "no-recording-id" },
        },
      ]);
      expect(await callState(callId)).toMatchObject({ has_recording: true });
    } finally {
      await admin.query("DELETE FROM calls WHERE id = $1", [callId]);
    }
  });

  it("alerts once when the provider has failed a recording three nights running, then deletes it once it's back", async () => {
    const t = await createTenant(admin, { businessName: "Retain H", trade: "locksmith" });
    const old = await seedCall({ tenantId: t, startedAt: daysAgo(35) });
    const voice = new FakeVoiceProvider();
    voice.deleteCallData = (id) =>
      id === old.providerCallId ? Promise.reject(new Error("provider down")) : Promise.resolve();
    const raised: Record<string, unknown>[] = [];
    const night = (n: number) =>
      runRetention({
        admin,
        voice,
        telephony: new FakeTelephonyProvider(),
        now: () => daysFrom(NOW, n),
        alert: (alert, details = {}) => {
          if (details["callId"] === old.callId) raised.push({ alert, ...details });
        },
      });

    await night(0);
    await night(1);
    expect(raised).toEqual([]); // a bad night or two isn't stuck yet
    await night(2);
    await night(3);
    expect(raised).toEqual([
      {
        alert: "recording-not-deleted",
        tenantId: t,
        callId: old.callId,
        attempts: 3,
        reason: "provider-failed",
      },
    ]);

    voice.deleteCallData = () => Promise.resolve();
    await night(4);
    expect(await callState(old.callId)).toMatchObject({ has_recording: false });
    expect(raised).toHaveLength(1);
  });

  it("stops deleting recordings when its time is up, and still clears the old transcripts", async () => {
    // A provider that hangs until its timeout on every recording would otherwise keep the run
    // going past the job's expiry, and the transcripts would never get their turn.
    const t = await createTenant(admin, { businessName: "Retain I", trade: "plumber" });
    const slow = await Promise.all(
      Array.from({ length: 4 }, (_, i) => seedCall({ tenantId: t, startedAt: daysAgo(31 + i) })),
    );
    const ancient = await seedCall({ tenantId: t, startedAt: daysAgo(400), recording: false });
    const voice = new FakeVoiceProvider();
    voice.deleteCallData = () => new Promise<void>((resolve) => setTimeout(resolve, 50));
    await runRetention({
      admin,
      voice,
      telephony: new FakeTelephonyProvider(),
      now: () => NOW,
      recordingTimeBudgetMs: 80,
    });
    const states = await Promise.all(slow.map((call) => callState(call.callId)));
    expect(states.filter((state) => state["has_recording"] === true).length).toBeGreaterThan(0);
    expect(await callState(ancient.callId)).toMatchObject({ has_transcript: false });

    // The next night, with time to spare, takes the rest.
    await runRetention({
      admin,
      voice: new FakeVoiceProvider(),
      telephony: new FakeTelephonyProvider(),
      now: () => NOW,
    });
    for (const call of slow) {
      expect(await callState(call.callId)).toMatchObject({ has_recording: false });
    }
  });

  it("does nothing the second time round", async () => {
    const t = await createTenant(admin, { businessName: "Retain D", trade: "electrician" });
    await seedCall({ tenantId: t, startedAt: daysAgo(60) });
    const voice = new FakeVoiceProvider();
    await runRetention({ admin, voice, telephony: new FakeTelephonyProvider(), now: () => NOW });
    const before = voice.deleteCalls.length;
    const again = await runRetention({
      admin,
      voice,
      telephony: new FakeTelephonyProvider(),
      now: () => NOW,
    });
    expect(voice.deleteCalls.length).toBe(before);
    expect(again).toMatchObject({ recordingsDeleted: 0, transcriptsCleared: 0 });
  });
});
