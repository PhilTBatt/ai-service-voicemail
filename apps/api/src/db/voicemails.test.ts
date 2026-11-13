import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { TRANSCRIPT_WAIT_SECONDS } from "../core/voicemail-transcription.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import { assignPhoneNumber, createAdminPool, createTenant } from "./cross-tenant.ts";
import { createPool } from "./pool.ts";
import { withTenant } from "./tenant.ts";
import { storeFallbackVoicemail, type FallbackVoicemail } from "./voicemails.ts";

const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);

afterAll(async () => {
  await Promise.all([app.end(), admin.end()]);
});

async function makeTenant() {
  const tenantId = await createTenant(admin, {
    businessName: "Voicemail Roofing",
    trade: "roofer",
  });
  const number = `+441914980${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
  await admin.query(
    "UPDATE phone_numbers SET status = 'released', released_at = now() WHERE number = $1 AND status = 'active'",
    [number],
  );
  await assignPhoneNumber(admin, tenantId, number, `PN${randomUUID()}`);
  return { tenantId, number };
}

const voicemail = (to: string, overrides: Partial<FallbackVoicemail> = {}): FallbackVoicemail => ({
  callSid: `CA${randomUUID().replace(/-/g, "")}`,
  from: "+447700900123",
  to,
  recordingUrl: "https://api.twilio.com/2010-04-01/Accounts/AC0/Recordings/RE1",
  durationSeconds: 42,
  startedAt: new Date("2026-11-06T18:00:00Z"),
  endedAt: new Date("2026-11-06T18:01:00Z"),
  ...overrides,
});

describe("storeFallbackVoicemail", () => {
  it("stores a call row for the tenant of the dialled number, marked as via the fallback", async () => {
    const { tenantId, number } = await makeTenant();
    const v = voicemail(number);
    expect(await storeFallbackVoicemail(app, v)).toEqual({ outcome: "stored", tenantId });

    const row = await withTenant(app, tenantId, async (client) => {
      const { rows } = await client.query(
        "SELECT caller_number, via_fallback, outcome, recording_ref, billable_seconds, extracted_fields FROM calls WHERE provider_call_id = $1",
        [v.callSid],
      );
      return rows[0] as unknown;
    });
    expect(row).toEqual({
      caller_number: "+447700900123",
      via_fallback: true,
      outcome: "voicemail",
      recording_ref: v.recordingUrl,
      billable_seconds: 0, // never billed: the fallback is our failure, not the customer's
      extracted_fields: { recordingSeconds: 42 },
    });
  });

  it("is a no-op the second time the same call is seen", async () => {
    const { tenantId, number } = await makeTenant();
    const v = voicemail(number);
    await storeFallbackVoicemail(app, v);
    expect(await storeFallbackVoicemail(app, v)).toEqual({ outcome: "duplicate", tenantId });
    const count = await withTenant(
      app,
      tenantId,
      async (client) =>
        (
          await client.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM calls WHERE provider_call_id = $1",
            [v.callSid],
          )
        ).rows[0],
    );
    expect(count).toEqual({ n: 1 });
  });

  it("stores a withheld caller number as null", async () => {
    const { tenantId, number } = await makeTenant();
    const v = voicemail(number, { from: null });
    await storeFallbackVoicemail(app, v);
    const row = await withTenant(
      app,
      tenantId,
      async (client) =>
        (
          await client.query<{ caller_number: string | null }>(
            "SELECT caller_number FROM calls WHERE provider_call_id = $1",
            [v.callSid],
          )
        ).rows[0],
    );
    expect(row).toEqual({ caller_number: null });
  });

  it("queues the voicemail text through the same transaction, and only once", async () => {
    const { tenantId, number } = await makeTenant();
    const v = voicemail(number);
    const enqueue = vi.fn(async (client: import("pg").ClientBase, call: { callId: string }) => {
      // Inside the transaction: this client already sees the new row.
      const { rowCount } = await client.query("SELECT 1 FROM calls WHERE id = $1", [call.callId]);
      expect(rowCount).toBe(1);
    });
    await storeFallbackVoicemail(app, v, enqueue);
    expect(enqueue).toHaveBeenCalledWith(expect.anything(), {
      tenantId,
      callId: expect.any(String) as string,
      urgency: null,
    });
    await storeFallbackVoicemail(app, v, enqueue);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("reports a number nobody owns rather than storing anything", async () => {
    expect(await storeFallbackVoicemail(app, voicemail("+441632960999"))).toEqual({
      outcome: "unknown-number",
      tenantId: null,
    });
  });
});

// Voicemail transcription (decision 022): asked for in the same transaction as the row, and the
// plain messages held for the transcript when one was asked for.
describe("storeFallbackVoicemail and transcription", () => {
  it("asks for the transcript with the row, and holds the messages for it", async () => {
    const { tenantId, number } = await makeTenant();
    const v = voicemail(number);
    const enqueueNotifications = vi.fn(() => Promise.resolve());
    const enqueueTranscription = vi.fn(
      async (client: import("pg").ClientBase, call: { callId: string }) => {
        const { rowCount } = await client.query("SELECT 1 FROM calls WHERE id = $1", [call.callId]);
        expect(rowCount).toBe(1); // inside the transaction
        return true;
      },
    );
    await storeFallbackVoicemail(app, v, enqueueNotifications, undefined, enqueueTranscription);
    expect(enqueueTranscription).toHaveBeenCalledWith(expect.anything(), {
      tenantId,
      callId: expect.any(String) as string,
      durationSeconds: 42,
      recordingUrl: v.recordingUrl,
    });
    expect(enqueueNotifications).toHaveBeenCalledWith(expect.anything(), {
      tenantId,
      callId: expect.any(String) as string,
      urgency: null,
      startAfterSeconds: TRANSCRIPT_WAIT_SECONDS,
    });
  });

  it("sends the messages at once when no transcript was asked for (the switch off, say)", async () => {
    const { tenantId, number } = await makeTenant();
    const enqueueNotifications = vi.fn(() => Promise.resolve());
    const enqueueTranscription = vi.fn(() => Promise.resolve(false));
    await storeFallbackVoicemail(
      app,
      voicemail(number),
      enqueueNotifications,
      undefined,
      enqueueTranscription,
    );
    expect(enqueueNotifications).toHaveBeenCalledWith(expect.anything(), {
      tenantId,
      callId: expect.any(String) as string,
      urgency: null,
    });
  });
});

describe("storeFallbackVoicemail and onboarding", () => {
  it("moves a business that's waiting for its test call on, and queues the go-live job with the call", async () => {
    const { tenantId, number } = await makeTenant();
    await admin.query(
      "UPDATE tenants SET onboarding_state = 'divert_instructions_sent' WHERE id = $1",
      [tenantId],
    );
    const enqueueOnboarding = vi.fn(() => Promise.resolve());

    await storeFallbackVoicemail(app, voicemail(number), undefined, enqueueOnboarding);
    const state = await admin.query<{ onboarding_state: string }>(
      "SELECT onboarding_state FROM tenants WHERE id = $1",
      [tenantId],
    );
    expect(state.rows[0]!.onboarding_state).toBe("test_call_received");
    expect(enqueueOnboarding).toHaveBeenCalledTimes(1);
    expect(enqueueOnboarding).toHaveBeenCalledWith(
      { tenantId, action: "go-live" },
      expect.anything(),
    );

    // Only the first call counts.
    await storeFallbackVoicemail(app, voicemail(number), undefined, enqueueOnboarding);
    expect(enqueueOnboarding).toHaveBeenCalledTimes(1);
  });

  it("leaves a business at any other step alone", async () => {
    const { tenantId, number } = await makeTenant();
    const enqueueOnboarding = vi.fn(() => Promise.resolve());
    await storeFallbackVoicemail(app, voicemail(number), undefined, enqueueOnboarding);
    const state = await admin.query<{ onboarding_state: string }>(
      "SELECT onboarding_state FROM tenants WHERE id = $1",
      [tenantId],
    );
    expect(state.rows[0]!.onboarding_state).toBe("created");
    expect(enqueueOnboarding).not.toHaveBeenCalled();
  });
});
