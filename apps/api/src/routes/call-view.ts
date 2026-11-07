// How a stored call is shown to a person: the JSON shape and the recording stream. Shared by
// the signed call page (/c/:token) and the dashboard API, so both show the same thing.
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { CallSummaryView, CallView } from "@callmate/shared";
import type { Response } from "express";
import { parseTranscript } from "../jobs/process-call.ts";
import { logger } from "../logger.ts";
import type { TelephonyProvider } from "../providers/telephony.ts";
import type { VoiceProvider } from "../providers/voice.ts";

/** The columns a call view needs; `SELECT ${CALL_VIEW_COLUMNS} FROM calls ...`. */
export const CALL_VIEW_COLUMNS =
  "id, provider_call_id, started_at, ended_at, billable_seconds, caller_number, urgency, summary, " +
  "flags, extracted_fields, transcript, recording_ref, via_fallback";

export interface CallRow {
  id: string;
  provider_call_id: string;
  started_at: Date;
  ended_at: Date | null;
  billable_seconds: number;
  caller_number: string | null;
  urgency: string | null;
  summary: string | null;
  flags: string[];
  extracted_fields: Record<string, unknown>;
  transcript: string | null;
  recording_ref: string | null;
  via_fallback: boolean;
}

/** Where recordings are fetched from. Either may be absent until that provider is configured. */
export interface RecordingSources {
  /** Streams fallback voicemail recordings. */
  telephony?: TelephonyProvider | undefined;
  /** Streams agent-call recordings. */
  voice?: VoiceProvider | undefined;
}

/** The line a call takes up in a list: no transcript, no recording. */
export function presentCallSummary(call: CallRow): CallSummaryView {
  const fields = call.extracted_fields;
  const str = (key: string) => (typeof fields[key] === "string" ? fields[key] : null);
  return {
    callId: call.id,
    startedAt: call.started_at.toISOString(),
    endedAt: call.ended_at?.toISOString() ?? null,
    // Voicemails aren't billed; their length is the recording's.
    durationSeconds: call.via_fallback
      ? typeof fields.recordingSeconds === "number"
        ? fields.recordingSeconds
        : 0
      : call.billable_seconds,
    callerNumber: call.caller_number,
    urgency: call.urgency,
    summary: call.summary,
    flags: call.flags,
    fields: {
      callerName: str("callerName"),
      callbackNumber: str("callbackNumber"),
      postcode: str("postcode"),
    },
    viaFallback: call.via_fallback,
  };
}

/** The whole call, with the transcript and where to stream the recording from. */
export function presentCall(
  call: CallRow,
  recordingUrl: string,
  sources: RecordingSources,
): CallView {
  return {
    ...presentCallSummary(call),
    transcript: call.transcript === null ? null : parseTranscript(call.transcript),
    recording: {
      // Voicemails are held by the telephony provider, agent calls by the voice platform.
      available:
        call.recording_ref !== null &&
        (call.via_fallback ? sources.telephony !== undefined : sources.voice !== undefined),
      url: recordingUrl,
    },
  };
}

/** Streams the call's recording into the response, or answers 404 when there isn't one. */
export async function streamRecording(
  res: Response,
  tenantId: string,
  call: CallRow,
  sources: RecordingSources,
): Promise<void> {
  const source = call.via_fallback ? sources.telephony : sources.voice;
  if (call.recording_ref === null || !source) {
    res.status(404).json({ error: "Recording not available" });
    return;
  }
  // The telephony provider is keyed by the stored recording URL; the voice platform is asked
  // for the call itself, because its recording URLs expire.
  const audio = call.via_fallback
    ? await (source as TelephonyProvider).fetchRecording(call.recording_ref)
    : await (source as VoiceProvider).fetchRecording(call.provider_call_id);
  if (!audio) {
    logger.warn("Recording missing at the provider", { tenantId, callId: call.id });
    res.status(404).json({ error: "Recording not available" });
    return;
  }
  res.type(audio.contentType);
  try {
    // pipeline() forwards a provider-side error here; pipe() would leave it unhandled and
    // take the whole process down.
    await pipeline(
      Readable.fromWeb(audio.body as import("node:stream/web").ReadableStream<Uint8Array>),
      res,
    );
  } catch (error) {
    logger.warn("Recording stream ended early", { tenantId, callId: call.id, error });
    res.destroy();
  }
}
