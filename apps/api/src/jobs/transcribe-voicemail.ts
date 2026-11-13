// The transcribe-voicemail job (decision 022): asks the telephony provider to transcribe a
// fallback voicemail's recording. Queued when the voicemail is stored, only while the switch
// (system_settings.voicemail_transcription_on) is on and the recording is long enough to be
// transcribed. The result comes back by webhook (routes/twilio.ts, /transcription) and is stored
// by db/voicemail-transcripts.ts. Idempotent on the call: a voicemail asked for once isn't asked
// for again, whatever the queue does.
import type { PgBoss } from "pg-boss";
import type pg from "pg";
import { storedFieldsSchema } from "../core/extraction.ts";
import { TRANSCRIBABLE_MIN_SECONDS, recordingSidFromUrl } from "../core/voicemail-transcription.ts";
import { withTenant } from "../db/tenant.ts";
import { logger } from "../logger.ts";
import type { TelephonyProvider } from "../providers/telephony.ts";
import { TRANSCRIBE_VOICEMAIL_QUEUE } from "./queue.ts";

export interface TranscribeVoicemailJobData {
  tenantId: string;
  callId: string;
}

/** What a stored voicemail offers for transcribing: enough to decide, nothing read twice. */
export interface TranscribableVoicemail {
  tenantId: string;
  callId: string;
  durationSeconds: number;
  recordingUrl: string | null;
}

/**
 * Queues the transcription of a voicemail through the transaction that stored it, if the switch
 * is on and the recording can be transcribed. Resolves true when a job was queued, so the caller
 * can hold the "new voicemail" messages for the transcript (db/voicemails.ts).
 */
export type EnqueueTranscription = (
  client: pg.ClientBase,
  voicemail: TranscribableVoicemail,
) => Promise<boolean>;

/** The cost line for a transcription asked for: the recording's length; priced per minute (core/prices.ts). */
export const TRANSCRIPTION_COST_COMPONENT = "twilio:transcription_seconds";

export async function voicemailTranscriptionOn(client: pg.ClientBase): Promise<boolean> {
  const { rows } = await client.query<{ voicemail_transcription_on: boolean }>(
    "SELECT voicemail_transcription_on FROM system_settings",
  );
  return rows[0]?.voicemail_transcription_on ?? false;
}

export function enqueueVoicemailTranscriptionWith(boss: PgBoss): EnqueueTranscription {
  return async (client, { tenantId, callId, durationSeconds, recordingUrl }) => {
    if (durationSeconds < TRANSCRIBABLE_MIN_SECONDS) return false;
    if (recordingSidFromUrl(recordingUrl) === null) return false;
    if (!(await voicemailTranscriptionOn(client))) return false;
    await boss.send(
      TRANSCRIBE_VOICEMAIL_QUEUE,
      { tenantId, callId } satisfies TranscribeVoicemailJobData,
      {
        singletonKey: callId,
        db: { executeSql: (text: string, values?: unknown[]) => client.query(text, values) },
      },
    );
    return true;
  };
}

export interface TranscribeVoicemailDeps {
  pool: pg.Pool;
  telephony: TelephonyProvider;
  /** The API's address, which the result webhook is sent to. */
  publicBaseUrl: string;
}

export type TranscribeVoicemailOutcome =
  "requested" | "already-requested" | "switched-off" | "no-recording" | "too-short";

export async function runTranscribeVoicemail(
  { pool, telephony, publicBaseUrl }: TranscribeVoicemailDeps,
  { tenantId, callId }: TranscribeVoicemailJobData,
): Promise<TranscribeVoicemailOutcome> {
  const loaded = await withTenant(pool, tenantId, async (client) => {
    const call = (
      await client.query<{
        via_fallback: boolean;
        recording_ref: string | null;
        transcription_ref: string | null;
        extracted_fields: unknown;
      }>(
        "SELECT via_fallback, recording_ref, transcription_ref, extracted_fields FROM calls WHERE id = $1",
        [callId],
      )
    ).rows[0];
    if (!call) throw new Error(`Call ${callId} not found for tenant ${tenantId}`);
    return { call, on: await voicemailTranscriptionOn(client) };
  });
  const { call } = loaded;
  if (call.transcription_ref !== null) return "already-requested";
  // Checked again here: the switch may have gone off between the voicemail and this job.
  if (!loaded.on) {
    logger.info("Voicemail not transcribed: the switch is off", { tenantId, callId });
    return "switched-off";
  }
  const recordingSid = call.via_fallback ? recordingSidFromUrl(call.recording_ref) : null;
  if (recordingSid === null) {
    logger.warn("Voicemail not transcribed: no recording to transcribe", { tenantId, callId });
    return "no-recording";
  }
  const fields = storedFieldsSchema.safeParse(call.extracted_fields);
  const durationSeconds = fields.success ? (fields.data.recordingSeconds ?? 0) : 0;
  if (durationSeconds < TRANSCRIBABLE_MIN_SECONDS) return "too-short";

  // Talk to the provider with no transaction open: it can take seconds. An error is thrown so
  // the queue retries (and dead-letters, with its alert, if it keeps failing).
  const { transcriptionRef } = await telephony.requestTranscription({
    recordingSid,
    callbackUrl: `${publicBaseUrl}/webhooks/twilio/transcription`,
  });

  await withTenant(pool, tenantId, async (client) => {
    // Only while nothing is recorded: a retry whose first attempt did get through (the reply
    // was lost) leaves the first request's reference in place.
    const { rowCount } = await client.query(
      `UPDATE calls
       SET transcription_ref = $2, transcription_status = 'requested', transcription_requested_at = now()
       WHERE id = $1 AND transcription_ref IS NULL`,
      [callId, transcriptionRef],
    );
    if (rowCount === 0) return;
    // What it costs: the recording's length, priced per minute on the Admin page (an estimate:
    // Twilio's rounding isn't documented, so each voicemail is counted as whole minutes, up).
    await client.query(
      `INSERT INTO call_costs (tenant_id, call_id, component, units, unit_type, is_estimated)
       VALUES ($1, $2, $3, $4, 'seconds', true)`,
      [tenantId, callId, TRANSCRIPTION_COST_COMPONENT, durationSeconds],
    );
  });
  logger.info("Voicemail transcription requested", { tenantId, callId, durationSeconds });
  return "requested";
}
