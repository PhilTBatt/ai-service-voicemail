// Storing a voicemail's transcript when the provider sends it (decision 022). The result names
// the transcription, not the business, so the business is found first (an owner-run lookup, like
// a call page's), then the transcript is written inside that business's transaction and the
// post-call job queued with it: the voicemail then gets a summary and an urgency like a call.
import type pg from "pg";
import { raiseAlert, type AlertFn } from "../alerts.ts";
import { voicemailTranscript } from "../core/voicemail-transcription.ts";
import type { EnqueueProcessCall } from "../jobs/process-call.ts";
import { logger } from "../logger.ts";
import type { TranscriptionResult } from "../providers/telephony.ts";
import { withTenant } from "./tenant.ts";

export async function findTenantIdByTranscriptionRef(
  appPool: pg.Pool,
  transcriptionRef: string,
): Promise<string | null> {
  const { rows } = await appPool.query<{ tenant_id: string | null }>(
    "SELECT tenant_id_for_transcription_ref($1) AS tenant_id",
    [transcriptionRef],
  );
  return rows[0]?.tenant_id ?? null;
}

export type StoreTranscriptOutcome =
  /** The words are on the call and the post-call job is queued. */
  | "stored"
  /** Transcribed, but no words in it: the plain voicemail message has gone, and that's all. */
  | "empty"
  /** The provider couldn't transcribe it (alerted). */
  | "failed"
  /** A result for this transcription was handled before (a redelivery). */
  | "already-handled"
  /** Still being worked on; the provider will say again. */
  | "pending"
  /** No voicemail asked for this transcription: a probe, or a business whose data has gone. */
  | "unknown-transcription";

export interface StoreTranscriptDeps {
  enqueueProcessCall?: EnqueueProcessCall | undefined;
  alert?: AlertFn | undefined;
}

export async function storeVoicemailTranscript(
  pool: pg.Pool,
  result: TranscriptionResult,
  { enqueueProcessCall, alert = raiseAlert }: StoreTranscriptDeps = {},
): Promise<{ outcome: StoreTranscriptOutcome; tenantId: string | null; callId: string | null }> {
  if (result.status === "pending") return { outcome: "pending", tenantId: null, callId: null };
  const tenantId = await findTenantIdByTranscriptionRef(pool, result.transcriptionRef);
  if (tenantId === null) return { outcome: "unknown-transcription", tenantId: null, callId: null };

  return withTenant(pool, tenantId, async (client) => {
    const call = (
      await client.query<{
        id: string;
        provider_call_id: string;
        transcription_status: string | null;
      }>(
        `SELECT id, provider_call_id, transcription_status FROM calls
         WHERE transcription_ref = $1 FOR UPDATE`,
        [result.transcriptionRef],
      )
    ).rows[0];
    if (!call) return { outcome: "unknown-transcription", tenantId, callId: null };
    const callId = call.id;
    if (call.transcription_status !== "requested") {
      return { outcome: "already-handled", tenantId, callId };
    }

    if (result.status === "failed") {
      await client.query("UPDATE calls SET transcription_status = 'failed' WHERE id = $1", [
        callId,
      ]);
      // Phil is paying for these: one that fails is worth knowing about. The error is the
      // provider's code and words, redacted by the adapter; never the recording's content.
      alert("voicemail-transcription-failed", { tenantId, callId, error: result.error });
      return { outcome: "failed", tenantId, callId };
    }

    const transcript = voicemailTranscript(result.text);
    if (transcript === null) {
      // Nothing was said (or nothing the provider could make out): the tradesperson already has
      // the plain "new voicemail" message with the recording, and a summary of silence helps nobody.
      await client.query("UPDATE calls SET transcription_status = 'completed' WHERE id = $1", [
        callId,
      ]);
      logger.info("Voicemail transcribed with no words in it", { tenantId, callId });
      return { outcome: "empty", tenantId, callId };
    }

    await client.query(
      `UPDATE calls SET transcript = $2, transcription_status = 'completed'
       WHERE id = $1`,
      [callId, transcript],
    );
    // The same job as a call's: the summary, the urgency and the messages (process-call.ts).
    await enqueueProcessCall?.(client, {
      tenantId,
      callId,
      providerCallId: call.provider_call_id,
    });
    logger.info("Voicemail transcript stored", {
      tenantId,
      callId,
      confidence: result.confidence,
      durationSeconds: result.durationSeconds,
    });
    return { outcome: "stored", tenantId, callId };
  });
}
