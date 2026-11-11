// Data retention (BUILD_PLAN Step 5, Appendix D): recordings go after 30 days, from our
// side and at the provider; transcripts, summaries and extracted fields go after 12 months.
// Runs daily across every tenant, logs counts only, and is safe to repeat.
import { raiseAlert, type AlertFn } from "../alerts.ts";
import {
  RECORDING_BATCH_SIZE,
  clearExpiredTranscripts,
  clearRecording,
  findExpiredRecordings,
  recordRecordingDeleteFailure,
  type AdminPool,
  type ExpiredRecording,
} from "../db/cross-tenant.ts";
import { logger } from "../logger.ts";
import type { TelephonyProvider } from "../providers/telephony.ts";
import type { VoiceProvider } from "../providers/voice.ts";

export const RECORDING_RETENTION_DAYS = 30;
export const TRANSCRIPT_RETENTION_MONTHS = 12;

/**
 * Batches of recordings one run works through at most: a backlog, or a provider that's down
 * and fails every one, is spread over a few nights rather than one very long run.
 */
export const RECORDING_MAX_BATCHES = 5;

/**
 * How long one run spends on recordings at most. The job expires after 30 minutes (jobs/queue.ts)
 * and a provider that hangs costs 10 to 15 seconds a recording before its timeout, so with more
 * than one batch a bad night could otherwise outlast the job and never reach the transcripts.
 * Measured in time, not failures: a reference that fails at once costs nothing against it, so
 * many of those can't use up the night the way a count of failures would let them.
 */
export const RECORDING_TIME_BUDGET_MS = 15 * 60_000;

/**
 * Runs in a row that couldn't delete a recording before it counts as stuck and is alerted about.
 * One failure is usually the provider having a bad night; three nights running isn't.
 */
export const RECORDING_ALERT_AFTER_FAILURES = 3;

export interface RetentionDeps {
  admin: AdminPool;
  /** Deletes platform calls' recordings, transcripts and logs. */
  voice: VoiceProvider;
  /** Deletes fallback voicemail recordings. */
  telephony: TelephonyProvider;
  now?: () => Date;
  alert?: AlertFn;
  /** Recordings per batch, batches and time per run: the defaults unless a test wants less. */
  recordingBatchSize?: number;
  recordingMaxBatches?: number;
  recordingTimeBudgetMs?: number;
}

export interface RetentionCounts {
  recordingsDeleted: number;
  recordingsFailed: number;
  transcriptsCleared: number;
}

/** A recording no retry can delete: retention alerts about it on its first failure. */
class RecordingNotDeletable extends Error {}

export async function runRetention({
  admin,
  voice,
  telephony,
  now = () => new Date(),
  alert = raiseAlert,
  recordingBatchSize = RECORDING_BATCH_SIZE,
  recordingMaxBatches = RECORDING_MAX_BATCHES,
  recordingTimeBudgetMs = RECORDING_TIME_BUDGET_MS,
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
  // provider call fails, the row keeps its reference, the failure is counted on the call, and a
  // later run tries again. The run then moves past it: the calls it has failed on this time are
  // left out of the next batch, and recordings no run has failed on yet come first each night,
  // so ones that can never be deleted can't keep the newer ones waiting.
  const failedThisRun: string[] = [];
  // Wall-clock time, not `now`: `now` says which day it is for the cut-offs, and tests set it.
  const startedAt = performance.now();
  let outOfTime = false;
  for (let batch = 0; batch < recordingMaxBatches && !outOfTime; batch++) {
    const expired = await findExpiredRecordings(admin, recordingsBefore, {
      limit: recordingBatchSize,
      skip: failedThisRun,
    });
    for (const recording of expired) {
      if (performance.now() - startedAt > recordingTimeBudgetMs) {
        // The rest wait for tomorrow; the transcripts still get their turn tonight.
        outOfTime = true;
        logger.warn("Recording deletion stopped for tonight: out of time", { ...counts });
        break;
      }
      try {
        await deleteAtProvider(recording, { voice, telephony });
        await clearRecording(admin, recording.callId);
        counts.recordingsDeleted += 1;
      } catch (error) {
        counts.recordingsFailed += 1;
        failedThisRun.push(recording.callId);
        await recordFailure(admin, recording, error, { now, alert });
      }
    }
    if (expired.length < recordingBatchSize) break;
  }

  counts.transcriptsCleared = await clearExpiredTranscripts(admin, transcriptsBefore);

  logger.info("Retention run finished", counts);
  return counts;
}

async function deleteAtProvider(
  recording: ExpiredRecording,
  { voice, telephony }: Pick<RetentionDeps, "voice" | "telephony">,
): Promise<void> {
  if (!recording.viaFallback) {
    await voice.deleteCallData(recording.providerCallId);
    return;
  }
  const sid = /RE[0-9a-f]{32}/.exec(recording.recordingRef)?.[0];
  // Clearing the row without deleting at Twilio would leave the audio there for good.
  if (!sid) {
    throw new RecordingNotDeletable("fallback recording reference has no Twilio recording SID");
  }
  await telephony.deleteRecording(sid);
}

/**
 * Counts the failure on the call, and says once, never again for the same recording, when it
 * looks stuck: straight away when no retry can work, or after a few nights in a row otherwise.
 * The alert is raised only once the database has recorded it, so a run that can't record it
 * doesn't leave the next one to say it again.
 */
async function recordFailure(
  admin: AdminPool,
  recording: ExpiredRecording,
  error: unknown,
  { now, alert }: { now: () => Date; alert: AlertFn },
): Promise<void> {
  const neverDeletable = error instanceof RecordingNotDeletable;
  const attempts = recording.attempts + 1;
  const stuck =
    !recording.alerted && (neverDeletable || attempts >= RECORDING_ALERT_AFTER_FAILURES);
  const where = { tenantId: recording.tenantId, callId: recording.callId };
  logger.warn("Recording deletion failed; a later run will try again", {
    ...where,
    attempts,
    error,
  });
  try {
    await recordRecordingDeleteFailure(admin, recording.callId, {
      alertedAt: stuck ? now() : null,
    });
  } catch (recordError) {
    logger.warn("Couldn't record the failed recording deletion", { ...where, error: recordError });
    return;
  }
  if (stuck) {
    alert("recording-not-deleted", {
      ...where,
      attempts,
      reason: neverDeletable ? "no-recording-id" : "provider-failed",
    });
  }
}
