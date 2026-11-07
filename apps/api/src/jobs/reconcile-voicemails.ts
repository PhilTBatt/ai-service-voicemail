// Finds fallback voicemails whose recording callback never reached the API (because it was
// down, which is when the fallback is used) and stores them. Runs on a schedule; safe to
// repeat, because storing a voicemail twice is a no-op.
import type pg from "pg";
import { storeFallbackVoicemail } from "../db/voicemails.ts";
import { logger } from "../logger.ts";
import type { TelephonyProvider } from "../providers/telephony.ts";
import type { EnqueueNotifications } from "./enqueue-notifications.ts";
import type { EnqueueOnboarding } from "./onboarding.ts";

export interface ReconcileDeps {
  pool: pg.Pool;
  telephony: TelephonyProvider;
  /** Queues the "new voicemail" text for each one stored. */
  enqueueNotifications?: EnqueueNotifications;
  /** Takes a business live after its test call (Step 11). */
  enqueueOnboarding?: EnqueueOnboarding;
  now?: () => Date;
  lookbackHours?: number;
}

export interface ReconcileCounts {
  checked: number;
  stored: number;
  duplicate: number;
  unknownNumber: number;
  noCallDetails: number;
}

export async function reconcileVoicemails({
  pool,
  telephony,
  enqueueNotifications,
  enqueueOnboarding,
  now = () => new Date(),
  lookbackHours = 24,
}: ReconcileDeps): Promise<ReconcileCounts> {
  const since = new Date(now().getTime() - lookbackHours * 3600_000);
  const counts: ReconcileCounts = {
    checked: 0,
    stored: 0,
    duplicate: 0,
    unknownNumber: 0,
    noCallDetails: 0,
  };

  for (const recording of await telephony.listRecentRecordings({ since })) {
    counts.checked += 1;
    const call = await telephony.getCall(recording.callSid);
    if (!call) {
      counts.noCallDetails += 1;
      continue;
    }
    const { outcome } = await storeFallbackVoicemail(
      pool,
      {
        callSid: call.callSid,
        from: call.from,
        to: call.to,
        recordingUrl: recording.url,
        durationSeconds: recording.durationSeconds,
        startedAt: call.startedAt,
        endedAt: call.endedAt,
      },
      enqueueNotifications,
      enqueueOnboarding,
    );
    if (outcome === "stored") counts.stored += 1;
    else if (outcome === "duplicate") counts.duplicate += 1;
    else counts.unknownNumber += 1;
  }

  // Counts only: never the numbers or recordings.
  logger.info("Voicemail reconciliation finished", { ...counts, lookbackHours });
  return counts;
}
