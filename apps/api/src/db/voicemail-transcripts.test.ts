import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { TranscriptionResult } from "../providers/telephony.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import { createAdminPool, createTenant } from "./cross-tenant.ts";
import { createPool } from "./pool.ts";
import { withTenant } from "./tenant.ts";
import {
  findTenantIdByTranscriptionRef,
  storeVoicemailTranscript,
} from "./voicemail-transcripts.ts";

const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);

afterAll(async () => {
  await Promise.all([app.end(), admin.end()]);
});

/** A fallback voicemail whose transcription has been asked for. */
async function makeRequestedVoicemail() {
  const tenantId = await createTenant(admin, {
    businessName: "Transcript Locks",
    trade: "locksmith",
  });
  const transcriptionRef = `voice_transcription_${randomUUID()}`;
  const providerCallId = `CA${randomUUID().replace(/-/g, "")}`;
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO calls (tenant_id, provider_call_id, caller_number, started_at, ended_at,
                        billable_seconds, outcome, recording_ref, via_fallback, extracted_fields,
                        transcription_ref, transcription_status, transcription_requested_at)
     VALUES ($1, $2, '+447700900123', now() - interval '1 minute', now(), 0, 'voicemail',
             'https://api.twilio.com/2010-04-01/Accounts/AC0/Recordings/RE1', true,
             '{"recordingSeconds": 42}', $3, 'requested', now())
     RETURNING id`,
    [tenantId, providerCallId, transcriptionRef],
  );
  return { tenantId, callId: rows[0]!.id, providerCallId, transcriptionRef };
}

const result = (
  transcriptionRef: string,
  overrides: Partial<TranscriptionResult> = {},
): TranscriptionResult => ({
  transcriptionRef,
  recordingSid: "RE1",
  status: "completed",
  text: "Hi, it's Sam. The back door lock's jammed and I can't get in.",
  confidence: 0.93,
  durationSeconds: 42,
  error: null,
  ...overrides,
});

const callRow = (tenantId: string, callId: string) =>
  withTenant(app, tenantId, async (client) => {
    const { rows } = await client.query(
      "SELECT transcript, transcription_status, summary, extracted_fields FROM calls WHERE id = $1",
      [callId],
    );
    return rows[0] as Record<string, unknown>;
  });

describe("findTenantIdByTranscriptionRef", () => {
  it("finds the business from the transcription alone, and nothing for an unknown one", async () => {
    const { tenantId, transcriptionRef } = await makeRequestedVoicemail();
    expect(await findTenantIdByTranscriptionRef(app, transcriptionRef)).toBe(tenantId);
    expect(await findTenantIdByTranscriptionRef(app, "voice_transcription_nobody")).toBeNull();
  });
});

describe("storeVoicemailTranscript", () => {
  it("stores the words as the caller's turn, queues the post-call job with them, and ignores a redelivery", async () => {
    const { tenantId, callId, providerCallId, transcriptionRef } = await makeRequestedVoicemail();
    const enqueueProcessCall = vi.fn(
      async (client: import("pg").ClientBase, data: { callId: string }) => {
        // Inside the transaction: this client already sees the transcript.
        const { rows } = await client.query<{ transcript: string }>(
          "SELECT transcript FROM calls WHERE id = $1",
          [data.callId],
        );
        expect(rows[0]?.transcript).toMatch(/^caller: /);
      },
    );
    expect(
      await storeVoicemailTranscript(app, result(transcriptionRef), { enqueueProcessCall }),
    ).toEqual({ outcome: "stored", tenantId, callId });
    expect(enqueueProcessCall).toHaveBeenCalledWith(expect.anything(), {
      tenantId,
      callId,
      providerCallId,
    });
    expect(await callRow(tenantId, callId)).toMatchObject({
      transcript: "caller: Hi, it's Sam. The back door lock's jammed and I can't get in.",
      transcription_status: "completed",
      summary: null, // the post-call job's to write
      extracted_fields: { recordingSeconds: 42 }, // untouched
    });

    // Twilio retries a callback it thinks failed: the second delivery changes nothing.
    expect(
      await storeVoicemailTranscript(app, result(transcriptionRef), { enqueueProcessCall }),
    ).toEqual({ outcome: "already-handled", tenantId, callId });
    expect(enqueueProcessCall).toHaveBeenCalledTimes(1);
  });

  it("records a failure and raises the alert, with the provider's reason and never any words", async () => {
    const { tenantId, callId, transcriptionRef } = await makeRequestedVoicemail();
    const alert = vi.fn();
    const enqueueProcessCall = vi.fn(() => Promise.resolve());
    expect(
      await storeVoicemailTranscript(
        app,
        result(transcriptionRef, { status: "failed", text: null, error: "32011: media too short" }),
        { enqueueProcessCall, alert },
      ),
    ).toEqual({ outcome: "failed", tenantId, callId });
    expect(alert).toHaveBeenCalledWith("voicemail-transcription-failed", {
      tenantId,
      callId,
      error: "32011: media too short",
    });
    expect(enqueueProcessCall).not.toHaveBeenCalled();
    expect(await callRow(tenantId, callId)).toMatchObject({
      transcript: null,
      transcription_status: "failed",
    });
  });

  it("leaves a transcript with no words in it alone: the plain voicemail message has gone", async () => {
    const { tenantId, callId, transcriptionRef } = await makeRequestedVoicemail();
    const enqueueProcessCall = vi.fn(() => Promise.resolve());
    expect(
      await storeVoicemailTranscript(app, result(transcriptionRef, { text: null }), {
        enqueueProcessCall,
      }),
    ).toEqual({ outcome: "empty", tenantId, callId });
    expect(enqueueProcessCall).not.toHaveBeenCalled();
    expect(await callRow(tenantId, callId)).toMatchObject({
      transcript: null,
      transcription_status: "completed",
    });
  });

  it("acknowledges a result still in progress, and one nothing asked for, touching nothing", async () => {
    const { tenantId, callId, transcriptionRef } = await makeRequestedVoicemail();
    expect(
      await storeVoicemailTranscript(
        app,
        result(transcriptionRef, { status: "pending", text: null }),
      ),
    ).toEqual({ outcome: "pending", tenantId: null, callId: null });
    expect(await storeVoicemailTranscript(app, result("voice_transcription_nobody"))).toEqual({
      outcome: "unknown-transcription",
      tenantId: null,
      callId: null,
    });
    expect(await callRow(tenantId, callId)).toMatchObject({
      transcript: null,
      transcription_status: "requested",
    });
  });
});
