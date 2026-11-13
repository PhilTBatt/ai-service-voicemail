// Voicemail transcription (decision 022): the bits with no database or provider in them. A
// fallback voicemail's recording is sent for transcription when the switch is on; the text comes
// back by webhook, is stored like a call's transcript, and gets the same summary and urgency.
import { oneLine } from "./notifications.ts";

/**
 * Twilio doesn't transcribe a recording under two seconds (its Batch Transcription docs, read
 * 2026-11-11), so one isn't asked for: nothing to charge for, nothing to wait on.
 */
export const TRANSCRIBABLE_MIN_SECONDS = 2;

/**
 * How long the "new voicemail" text and email wait for the transcript when one has been asked
 * for, so the tradesperson's one text and one email carry the summary rather than just "new
 * voicemail". A short recording transcribes in seconds; if the transcript comes later, the plain
 * message goes at this point, and as a call gets one text and one email (jobs/deliver-
 * notification.ts), the summary is then on the call page and the dashboard only. Emergency texts
 * never wait: they go the moment the transcript is read, however late. Within the 60 seconds the
 * synthetic calls allow for a call's messages.
 */
export const TRANSCRIPT_WAIT_SECONDS = 45;

/** The last path segment of a stored Twilio recording URL, when it's a recording SID. */
export function recordingSidFromUrl(recordingUrl: string | null): string | null {
  if (recordingUrl === null) return null;
  const last = recordingUrl.split("?")[0]!.replace(/\/+$/, "").split("/").at(-1) ?? "";
  return /^RE[0-9a-f]{32}$/i.test(last) ? last : null;
}

/**
 * A voicemail's transcript as calls.transcript stores a call's: one "role: text" line a turn
 * (jobs/process-call.ts parseTranscript). A voicemail is one turn, the caller's, on one line.
 * Null when there were no words: nothing to summarise, and the plain voicemail message has gone.
 */
export function voicemailTranscript(text: string | null): string | null {
  const line = oneLine(text ?? "");
  return line === "" ? null : `caller: ${line}`;
}

/** Whole minutes, each voicemail rounded up on its own: the usual way a per-minute price is billed. */
export function transcriptionMinutes(durationSeconds: number): number {
  return durationSeconds <= 0 ? 0 : Math.ceil(durationSeconds / 60);
}
