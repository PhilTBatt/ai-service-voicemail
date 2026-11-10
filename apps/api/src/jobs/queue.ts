import { PgBoss } from "pg-boss";
import type pg from "pg";
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
/** Onboarding texts and going live after the test call (BUILD_PLAN Step 11). */
export const ONBOARDING_QUEUE = "onboarding";
/** Messages when a business leaves, and deleting its data (BUILD_PLAN Step 13). */
export const OFFBOARDING_QUEUE = "offboarding";

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
    // Where email isn't configured, waiting jobs are kept this long, then deleted (not
    // dead-lettered); the default is 14 days, stated here.
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
  await ensureQueue(boss, ONBOARDING_QUEUE, {
    policy: "exclusive", // one of each action per business queued or running
    retryLimit: 5,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 60,
    deadLetter: DEAD_LETTER_QUEUE,
  });
  await ensureQueue(boss, OFFBOARDING_QUEUE, {
    policy: "exclusive", // one of each action per business queued or running
    retryLimit: 5,
    retryDelay: 60,
    retryBackoff: true,
    // Deleting a busy business's data at the providers is one request at a time, which for
    // thousands of calls takes many minutes. A run that outlasts this is retried; a lock keeps
    // the two apart (jobs/offboarding.ts).
    expireInSeconds: 3600,
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
  if (await boss.getQueue(name)) {
    // Retry and expiry settings live in the database, so a change here must reach queues
    // that already exist. The policy can't be changed after creation.
    const { retryLimit, retryDelay, retryBackoff, expireInSeconds, retentionSeconds, deadLetter } =
      options ?? {};
    const updates = {
      ...(retryLimit !== undefined && { retryLimit }),
      ...(retryDelay !== undefined && { retryDelay }),
      ...(retryBackoff !== undefined && { retryBackoff }),
      ...(expireInSeconds !== undefined && { expireInSeconds }),
      ...(retentionSeconds !== undefined && { retentionSeconds }),
      ...(deadLetter !== undefined && { deadLetter }),
    };
    // pg-boss refuses an empty update (the dead-letter queue has only defaults).
    if (Object.keys(updates).length > 0) await boss.updateQueue(name, updates);
  } else {
    await boss.createQueue(name, options);
  }
}

/** How many jobs failed every retry and were dead-lettered since `since` (the admin health screen). */
export async function countDeadLettered(pool: pg.Pool, since: Date): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM pgboss.job WHERE name = $1 AND created_on >= $2",
    [DEAD_LETTER_QUEUE, since],
  );
  return rows[0]!.n;
}

export interface DeadLetteredJob {
  /** The queue the job failed on: "notify-sms", "process-call"... */
  queue: string;
  /** What the job was about, as it was queued: usually a tenant and a call. */
  data: Record<string, unknown>;
  /** The error that failed the last attempt, as pg-boss recorded it (already redacted by the providers). */
  error: string | null;
  at: Date;
}

/**
 * The latest jobs that failed every retry, newest first, for the admin's health screen. A
 * dead-lettered job is a copy in the dead-letter queue carrying the original's queue name
 * and last error (pg-boss's source_* columns).
 */
export async function recentDeadLetters(
  pool: pg.Pool,
  since: Date,
  limit = 10,
): Promise<DeadLetteredJob[]> {
  const { rows } = await pool.query<{
    queue: string | null;
    data: Record<string, unknown> | null;
    output: unknown;
    at: Date;
  }>(
    `SELECT source_name AS queue, data, source_output AS output, created_on AS at
     FROM pgboss.job WHERE name = $1 AND created_on >= $2
     ORDER BY created_on DESC LIMIT $3`,
    [DEAD_LETTER_QUEUE, since, limit],
  );
  return rows.map((row) => ({
    queue: row.queue ?? "unknown",
    data: row.data ?? {},
    error: errorText(row.output),
    at: row.at,
  }));
}

/** pg-boss stores a thrown Error's fields as JSON; the message is the part a person needs. */
function errorText(output: unknown): string | null {
  if (output === null || output === undefined) return null;
  if (typeof output === "object" && "message" in output && typeof output.message === "string") {
    return output.message.slice(0, 300);
  }
  return JSON.stringify(output).slice(0, 300);
}
