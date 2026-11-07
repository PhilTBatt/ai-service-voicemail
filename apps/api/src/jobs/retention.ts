// Data retention (BUILD_PLAN Step 5, Appendix D): recordings go after 30 days, from our
// side and at the provider; transcripts, summaries and extracted fields go after 12 months.
// Runs daily across every tenant, logs counts only, and is safe to repeat.
import {
  clearExpiredTranscripts,
  clearRecording,
  findExpiredRecordings,
  type AdminPool,
} from "../db/cross-tenant.ts";
import { logger } from "../logger.ts";
import type { TelephonyProvider } from "../providers/telephony.ts";
import type { VoiceProvider } from "../providers/voice.ts";

export const RECORDING_RETENTION_DAYS = 30;
export const TRANSCRIPT_RETENTION_MONTHS = 12;

export interface RetentionDeps {
  admin: AdminPool;
  /** Deletes platform calls' recordings, transcripts and logs. */
  voice: VoiceProvider;
  /** Deletes fallback voicemail recordings. */
  telephony: TelephonyProvider;
  now?: () => Date;
}

export interface RetentionCounts {
  recordingsDeleted: number;
  recordingsFailed: number;
  transcriptsCleared: number;
}

export async function runRetention({
  admin,
  voice,
  telephony,
  now = () => new Date(),
}: RetentionDeps): Promise<RetentionCounts> {
  const today = Temporal.Instant.fromEpochMilliseconds(now().getTime()).toZonedDateTimeISO(
    "Europe/London",
  );
  const recordingsBefore = new Date(
    today.subtract({ days: RECORDING_RETENTION_DAYS }).epochMilliseconds,
  );
  const transcriptsBefore = new Date(
    today.subtract({ months: TRANSCRIPT_RETENTION_MONTHS }).epochMilliseconds,
  );

  const counts: RetentionCounts = {
    recordingsDeleted: 0,
    recordingsFailed: 0,
    transcriptsCleared: 0,
  };

  // One at a time, and the row is only cleared once the provider has deleted its copy. If a
  // provider call fails, the row keeps its reference and tomorrow's run tries again.
  for (const expired of await findExpiredRecordings(admin, recordingsBefore)) {
    try {
      if (expired.viaFallback) {
        const sid = /RE[0-9a-f]{32}/.exec(expired.recordingRef)?.[0];
        // Clearing the row without deleting at Twilio would leave the audio there for good.
        if (!sid) throw new Error("fallback recording reference has no Twilio recording SID");
        await telephony.deleteRecording(sid);
      } else {
        await voice.deleteCallData(expired.providerCallId);
      }
      await clearRecording(admin, expired.callId);
      counts.recordingsDeleted += 1;
    } catch (error) {
      counts.recordingsFailed += 1;
      logger.warn("Recording deletion failed; will retry tomorrow", {
        tenantId: expired.tenantId,
        callId: expired.callId,
        error,
      });
    }
  }

  counts.transcriptsCleared = await clearExpiredTranscripts(admin, transcriptsBefore);

  logger.info("Retention run finished", counts);
  return counts;
}
