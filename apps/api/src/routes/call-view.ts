// How a stored call is shown to a person: the JSON shape and the recording stream. Shared by
// the signed call page (/c/:token) and the dashboard API, so both show the same thing.
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { CallSummaryView, CallView } from "@callmate/shared";
import type { Request, Response } from "express";
import { parseTranscript } from "../jobs/process-call.ts";
import { logger } from "../logger.ts";
import type { TelephonyProvider } from "../providers/telephony.ts";
import type { VoiceProvider } from "../providers/voice.ts";

/** The columns a call view needs; `SELECT ${CALL_VIEW_COLUMNS} FROM calls ...`. */
export const CALL_VIEW_COLUMNS =
  "id, provider_call_id, started_at, ended_at, billable_seconds, caller_number, urgency, summary, " +
  "flags, extracted_fields, transcript, recording_ref, via_fallback, handled_at";

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
  /** When it was marked called back, or null while it is open (db/call-handled.ts). */
  handled_at: Date | null;
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
    handledAt: call.handled_at?.toISOString() ?? null,
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

/**
 * Streams the call's recording into the response, or answers 404 when there isn't one. A
 * request for a byte range gets that range (206): Safari, which every browser on an iPhone is,
 * asks for audio in ranges and won't play it otherwise (Apple: "HTTP servers hosting media
 * files for iOS must support byte-range requests"). The providers send the whole file, so for a
 * range it's read into memory and sliced: a few MB at most, for calls capped at 8 minutes.
 */
export async function streamRecording(
  req: Request,
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
  // Only ever an audio type: the provider says what it's sending, and if that were somehow a
  // page, a browser would otherwise run it as this site. The bytes are passed on unchanged.
  res.type(audio.contentType.startsWith("audio/") ? audio.contentType : "application/octet-stream");
  res.setHeader("Accept-Ranges", "bytes");
  if (req.headers.range !== undefined) {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(await new globalThis.Response(audio.body).arrayBuffer());
    } catch (error) {
      logger.warn("Recording read ended early", { tenantId, callId: call.id, error });
      res.status(502).json({ error: "Recording not available" });
      return;
    }
    const ranges = req.range(bytes.length, { combine: true });
    if (ranges === -1) {
      res.status(416).setHeader("Content-Range", `bytes */${bytes.length}`).end();
      return;
    }
    // One range, as players ask for: that slice. Anything else (malformed, several at once)
    // gets the whole file, which the standard allows a server to send instead.
    const range =
      ranges !== -2 && ranges?.type === "bytes" && ranges.length === 1 ? ranges[0] : null;
    if (!range) {
      res.setHeader("Content-Length", bytes.length).end(bytes);
      return;
    }
    res
      .status(206)
      .setHeader("Content-Range", `bytes ${range.start}-${range.end}/${bytes.length}`)
      .setHeader("Content-Length", range.end - range.start + 1)
      .end(bytes.subarray(range.start, range.end + 1));
    return;
  }
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
