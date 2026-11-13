import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { assignPhoneNumber, createAdminPool, createTenant } from "../db/cross-tenant.ts";
import { createPool } from "../db/pool.ts";
import { withTenant } from "../db/tenant.ts";
import { FakeTelephonyProvider } from "../providers/telephony.fake.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import {
  GLOBAL_SETTINGS_LOCK_TIMEOUT_MS,
  holdGlobalSettings,
} from "../testing/global-settings-lock.ts";
import { TRANSCRIBE_VOICEMAIL_QUEUE } from "./queue.ts";
import {
  TRANSCRIPTION_COST_COMPONENT,
  enqueueVoicemailTranscriptionWith,
  runTranscribeVoicemail,
} from "./transcribe-voicemail.ts";

const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);
const PUBLIC_BASE_URL = "https://callmate.example.com";
const RECORDING_URL = `https://api.twilio.com/2010-04-01/Accounts/AC0/Recordings/RE${"a".repeat(32)}`;

// The switch is one setting for the whole service: this file takes its turn with the others
// that change or check system_settings (testing/global-settings-lock.ts).
let releaseGlobalSettings: () => Promise<void>;
beforeAll(async () => {
  releaseGlobalSettings = await holdGlobalSettings();
}, GLOBAL_SETTINGS_LOCK_TIMEOUT_MS);
afterAll(async () => {
  await admin.query("UPDATE system_settings SET voicemail_transcription_on = false");
  await releaseGlobalSettings();
  await Promise.all([app.end(), admin.end()]);
});
afterEach(async () => {
  await admin.query("UPDATE system_settings SET voicemail_transcription_on = false");
});

const switchOn = () => admin.query("UPDATE system_settings SET voicemail_transcription_on = true");

/** A tenant with one stored fallback voicemail of `seconds`. */
async function makeVoicemail(seconds = 42, recordingUrl: string | null = RECORDING_URL) {
  const tenantId = await createTenant(admin, {
    businessName: "Transcribe Roofing",
    trade: "roofer",
  });
  await assignPhoneNumber(
    admin,
    tenantId,
    `+441914980${String(Math.floor(Math.random() * 990)).padStart(3, "0")}`,
    `PN${randomUUID()}`,
  ).catch(() => undefined);
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO calls (tenant_id, provider_call_id, caller_number, started_at, ended_at,
                        billable_seconds, outcome, recording_ref, via_fallback, extracted_fields)
     VALUES ($1, $2, '+447700900123', now() - interval '1 minute', now(), 0, 'voicemail', $3, true, $4)
     RETURNING id`,
    [
      tenantId,
      `CA${randomUUID().replace(/-/g, "")}`,
      recordingUrl,
      JSON.stringify({ recordingSeconds: seconds }),
    ],
  );
  return { tenantId, callId: rows[0]!.id };
}

const callRow = (tenantId: string, callId: string) =>
  withTenant(app, tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT transcription_ref, transcription_status, transcription_requested_at FROM calls WHERE id = $1`,
      [callId],
    );
    const costs = await client.query<{ component: string; units: string; unit_type: string }>(
      "SELECT component, units, unit_type FROM call_costs WHERE call_id = $1",
      [callId],
    );
    return { ...(rows[0] as Record<string, unknown>), costs: costs.rows };
  });

/** A pg-boss stand-in: records each send and what transaction it went through. */
function recorder() {
  const sent: { queue: string; data: unknown; options: Record<string, unknown> }[] = [];
  const boss = {
    send: (queue: string, data: unknown, options: Record<string, unknown>) => {
      sent.push({ queue, data, options });
      return Promise.resolve("job-id");
    },
  } as unknown as import("pg-boss").PgBoss;
  return { boss, sent };
}

describe("enqueueVoicemailTranscriptionWith", () => {
  const voicemail = (
    tenantId: string,
    callId: string,
    seconds = 42,
    url: string | null = RECORDING_URL,
  ) => ({
    tenantId,
    callId,
    durationSeconds: seconds,
    recordingUrl: url,
  });

  it("queues nothing while the switch is off", async () => {
    const { tenantId, callId } = await makeVoicemail();
    const { boss, sent } = recorder();
    const queued = await withTenant(app, tenantId, (client) =>
      enqueueVoicemailTranscriptionWith(boss)(client, voicemail(tenantId, callId)),
    );
    expect(queued).toBe(false);
    expect(sent).toEqual([]);
  });

  it("queues one job per voicemail through the caller's transaction once the switch is on", async () => {
    await switchOn();
    const { tenantId, callId } = await makeVoicemail();
    const { boss, sent } = recorder();
    const queued = await withTenant(app, tenantId, (client) =>
      enqueueVoicemailTranscriptionWith(boss)(client, voicemail(tenantId, callId)),
    );
    expect(queued).toBe(true);
    expect(sent).toEqual([
      {
        queue: TRANSCRIBE_VOICEMAIL_QUEUE,
        data: { tenantId, callId },
        options: { singletonKey: callId, db: { executeSql: expect.any(Function) as unknown } },
      },
    ]);
  });

  // Twilio won't transcribe under two seconds, and a reference with no recording SID can't be sent.
  it("skips a recording too short to transcribe, and one with no recording SID", async () => {
    await switchOn();
    const { tenantId, callId } = await makeVoicemail();
    const { boss, sent } = recorder();
    const enqueue = enqueueVoicemailTranscriptionWith(boss);
    await withTenant(app, tenantId, async (client) => {
      expect(await enqueue(client, voicemail(tenantId, callId, 1))).toBe(false);
      expect(await enqueue(client, voicemail(tenantId, callId, 42, "rec_ref_1"))).toBe(false);
      expect(await enqueue(client, voicemail(tenantId, callId, 42, null))).toBe(false);
      expect(await enqueue(client, voicemail(tenantId, callId, 2))).toBe(true);
    });
    expect(sent).toHaveLength(1);
  });
});

describe("runTranscribeVoicemail", () => {
  const deps = (telephony = new FakeTelephonyProvider()) => ({
    pool: app,
    telephony,
    publicBaseUrl: PUBLIC_BASE_URL,
  });

  it("asks the provider once, records the reference and a cost line, and sends nothing a second time", async () => {
    await switchOn();
    const { tenantId, callId } = await makeVoicemail(42);
    const d = deps();
    expect(await runTranscribeVoicemail(d, { tenantId, callId })).toBe("requested");
    expect(d.telephony.transcriptionRequests).toEqual([
      {
        recordingSid: `RE${"a".repeat(32)}`,
        callbackUrl: `${PUBLIC_BASE_URL}/webhooks/twilio/transcription`,
      },
    ]);
    expect(await callRow(tenantId, callId)).toMatchObject({
      transcription_ref: "fake_transcription_1",
      transcription_status: "requested",
      transcription_requested_at: expect.any(Date) as unknown,
      costs: [{ component: TRANSCRIPTION_COST_COMPONENT, units: "42.0000", unit_type: "seconds" }],
    });

    expect(await runTranscribeVoicemail(d, { tenantId, callId })).toBe("already-requested");
    expect(d.telephony.transcriptionRequests).toHaveLength(1);
    expect((await callRow(tenantId, callId)).costs).toHaveLength(1);
  });

  it("sends nothing if the switch went off between the voicemail and the job", async () => {
    const { tenantId, callId } = await makeVoicemail();
    const d = deps();
    expect(await runTranscribeVoicemail(d, { tenantId, callId })).toBe("switched-off");
    expect(d.telephony.transcriptionRequests).toEqual([]);
    expect(await callRow(tenantId, callId)).toMatchObject({ transcription_ref: null, costs: [] });
  });

  it("sends nothing for a voicemail with no recording SID, or one too short", async () => {
    await switchOn();
    const noSid = await makeVoicemail(42, "rec_ref_1");
    const d = deps();
    expect(await runTranscribeVoicemail(d, noSid)).toBe("no-recording");
    const short = await makeVoicemail(1);
    expect(await runTranscribeVoicemail(d, short)).toBe("too-short");
    expect(d.telephony.transcriptionRequests).toEqual([]);
  });

  it("lets a provider error propagate so the queue retries, recording nothing", async () => {
    await switchOn();
    const { tenantId, callId } = await makeVoicemail();
    const telephony = new FakeTelephonyProvider();
    telephony.transcriptionError = new Error("Twilio 503");
    await expect(runTranscribeVoicemail(deps(telephony), { tenantId, callId })).rejects.toThrow(
      "Twilio 503",
    );
    expect(await callRow(tenantId, callId)).toMatchObject({
      transcription_ref: null,
      transcription_status: null,
      costs: [],
    });
  });

  it("works through the tenant's own transaction: another business's voicemail is out of reach", async () => {
    await switchOn();
    const { callId } = await makeVoicemail();
    const other = await createTenant(admin, { businessName: "Other Roofing", trade: "roofer" });
    await expect(runTranscribeVoicemail(deps(), { tenantId: other, callId })).rejects.toThrow(
      /not found/,
    );
  });
});
