import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { clearExpiredTranscripts, createAdminPool, createTenant } from "../db/cross-tenant.ts";
import { FakeTelephonyProvider } from "../providers/telephony.fake.ts";
import { FakeVoiceProvider } from "../providers/voice.fake.ts";
import { TEST_ADMIN_DATABASE_URL } from "../testing/databases.ts";
import { runRetention } from "./retention.ts";

const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);
const NOW = new Date("2026-11-06T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

afterAll(async () => {
  await admin.end();
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
