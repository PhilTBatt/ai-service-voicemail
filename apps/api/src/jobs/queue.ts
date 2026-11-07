import { PgBoss } from "pg-boss";
import { logger } from "../logger.ts";

export const SYNC_AGENT_QUEUE = "sync-agent";
/** One job per finished call, keyed by the provider's call ID (BUILD_PLAN Step 5). */
export const PROCESS_CALL_QUEUE = "process-call";
/** Scheduled: picks up fallback voicemails whose callback never arrived. */
export const RECONCILE_VOICEMAILS_QUEUE = "reconcile-voicemails";
export const RECONCILE_VOICEMAILS_CRON = "*/15 * * * *";
/** Scheduled: stores agent calls whose call-ended webhook never arrived (Step 7 review). */
export const RECONCILE_CALLS_QUEUE = "reconcile-calls";
export const RECONCILE_CALLS_CRON = "7-59/15 * * * *"; // staggered from the voicemail run
/** Scheduled: deletes expired recordings and transcripts (BUILD_PLAN Step 5). */
export const RETENTION_QUEUE = "retention";
export const RETENTION_CRON = "30 3 * * *"; // 03:30 Europe/London, every day
/** One text per processed call, keyed by the call ID (BUILD_PLAN Step 6). */
export const NOTIFY_SMS_QUEUE = "notify-sms";
/** The email for a call (BUILD_PLAN Step 6). Waits in the queue until an email provider is configured. */
export const NOTIFY_EMAIL_QUEUE = "notify-email";
/**
 * The emergency texts for a call (BUILD_PLAN Step 6). Its own queue, with short retry
 * delays, so an emergency never waits behind ordinary texts.
 */
export const NOTIFY_EMERGENCY_QUEUE = "notify-emergency";
/** Jobs that failed every retry land here, and anything in here raises an alert (Step 5). */
export const DEAD_LETTER_QUEUE = "dead-letter";

/**
 * Starts pg-boss as the app role. Its schema was installed by a migration (decision 008),
 * so pg-boss never creates or migrates anything itself: if a pg-boss upgrade needs a
 * schema change, start() fails fast instead of altering the database at runtime.
 */
export async function startQueue(connectionString: string): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString,
    schema: "pgboss",
    migrate: false,
    createSchema: false,
  });
  boss.on("error", (error: Error) => logger.error("Job queue error", { error }));
  await boss.start();

  await ensureQueue(boss, DEAD_LETTER_QUEUE, {});
  await ensureQueue(boss, SYNC_AGENT_QUEUE, {
    // One job per singletonKey (tenant + profile version) queued or active at a time.
    policy: "exclusive",
    retryLimit: 5,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 120,
    deadLetter: DEAD_LETTER_QUEUE,
  });
  await ensureQueue(boss, PROCESS_CALL_QUEUE, {
    policy: "exclusive", // at most one job per provider call ID queued or active
    retryLimit: 5,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 300,
    deadLetter: DEAD_LETTER_QUEUE,
  });
  await ensureQueue(boss, NOTIFY_SMS_QUEUE, {
    policy: "exclusive", // at most one job per call queued or active
    retryLimit: 5,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 60,
    deadLetter: DEAD_LETTER_QUEUE,
  });
  await ensureQueue(boss, NOTIFY_EMAIL_QUEUE, {
    policy: "exclusive",
    retryLimit: 5,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 60,
    // Until the email adapter exists (decision 010) nothing works this queue. Waiting jobs are
    // kept this long, then deleted (not dead-lettered): the default is 14 days, stated here.
    retentionSeconds: 30 * 24 * 60 * 60,
    deadLetter: DEAD_LETTER_QUEUE,
  });
  await ensureQueue(boss, NOTIFY_EMERGENCY_QUEUE, {
    policy: "exclusive",
    retryLimit: 5,
    retryDelay: 10, // seconds: an emergency can't wait half a minute between tries
    retryBackoff: true,
    expireInSeconds: 60,
    deadLetter: DEAD_LETTER_QUEUE,
  });
  await ensureQueue(boss, RETENTION_QUEUE, {
    policy: "singleton",
    retryLimit: 2,
    retryDelay: 300,
    expireInSeconds: 1800,
    deadLetter: DEAD_LETTER_QUEUE,
  });
  await ensureQueue(boss, RECONCILE_CALLS_QUEUE, {
    policy: "singleton",
    retryLimit: 2,
    retryDelay: 60,
    expireInSeconds: 600,
    deadLetter: DEAD_LETTER_QUEUE,
  });
  await ensureQueue(boss, RECONCILE_VOICEMAILS_QUEUE, {
    policy: "singleton", // never two reconciliations at once
    retryLimit: 2,
    retryDelay: 60,
    expireInSeconds: 300,
    deadLetter: DEAD_LETTER_QUEUE,
  });
  return boss;
}

async function ensureQueue(
  boss: PgBoss,
  name: string,
  options: Parameters<PgBoss["createQueue"]>[1],
) {
  if (!(await boss.getQueue(name))) await boss.createQueue(name, options);
}
