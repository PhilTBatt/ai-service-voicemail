// When each recurring job last ran, and whether one has stopped (BUILD_PLAN Step 14, monitoring).
// pg-boss runs the four recurring jobs on their cron, and nothing used to notice one stopping:
// a worker started without GoCardless's settings quietly stops charging (one warning in its
// start-up log), and a cron that never fires looks exactly like a quiet night. Failing runs
// were already covered (they dead-letter, with an alert); a run that never happens wasn't.
// The worker records each run here and checks every few minutes; the Admin page shows the rows.
import type pg from "pg";
import { raiseAlert, type AlertFn } from "../alerts.ts";
import {
  CHARGE_PERIODS_QUEUE,
  RECONCILE_CALLS_QUEUE,
  RECONCILE_VOICEMAILS_QUEUE,
  RETENTION_QUEUE,
} from "../jobs/queue.ts";
import { logger } from "../logger.ts";

const HOUR_MS = 60 * 60_000;

/**
 * The recurring jobs: what each does, in words, and how long without a success means it has
 * stopped. The every-15-minutes jobs: four missed runs. The daily ones: a day and two hours,
 * so the 25-hour day when the clocks go back is still on time.
 */
export const SCHEDULED_JOBS: Readonly<Record<string, { label: string; overdueAfterMs: number }>> = {
  [RECONCILE_VOICEMAILS_QUEUE]: {
    label: "Voicemails checked against Twilio (every 15 minutes)",
    overdueAfterMs: HOUR_MS,
  },
  [RECONCILE_CALLS_QUEUE]: {
    label: "Calls checked against Retell (every 15 minutes)",
    overdueAfterMs: HOUR_MS,
  },
  [RETENTION_QUEUE]: {
    label: "Old recordings and transcripts deleted (03:30 daily)",
    overdueAfterMs: 26 * HOUR_MS,
  },
  [CHARGE_PERIODS_QUEUE]: {
    label: "Ended billing months charged (06:00 daily)",
    overdueAfterMs: 26 * HOUR_MS,
  },
};

/** How often the worker looks for an overdue job. */
export const SCHEDULE_CHECK_INTERVAL_MS = 10 * 60_000;

export interface ScheduledRun {
  queue: string;
  /** When a worker first scheduled it: the overdue clock until its first success. */
  registeredAt: Date;
  lastStartedAt: Date | null;
  lastSucceededAt: Date | null;
  lastFailedAt: Date | null;
}

export function isScheduledJob(queue: string): boolean {
  return Object.hasOwn(SCHEDULED_JOBS, queue);
}

/**
 * Puts each recurring job this worker runs on record. Only the first time: a restart doesn't
 * reset the clock, so a job that's broken can't be hidden by restarting the worker.
 */
export async function registerScheduledRuns(
  pool: pg.Pool,
  queues: readonly string[],
): Promise<void> {
  const scheduled = queues.filter(isScheduledJob);
  if (scheduled.length === 0) return;
  await pool.query(
    "INSERT INTO scheduled_runs (queue) SELECT unnest($1::text[]) ON CONFLICT (queue) DO NOTHING",
    [scheduled],
  );
}

type RunColumn = "last_started_at" | "last_succeeded_at" | "last_failed_at";

/** Stamps one column with the database's time. A failure to record never stops the job. */
async function stamp(pool: pg.Pool, queue: string, column: RunColumn): Promise<void> {
  try {
    // The column is one of three fixed names, never input.
    await pool.query(
      `INSERT INTO scheduled_runs (queue, ${column}) VALUES ($1, now())
       ON CONFLICT (queue) DO UPDATE SET ${column} = now()`,
      [queue],
    );
  } catch (error) {
    logger.warn("Couldn't record a scheduled run", { queue, column, error });
  }
}

/**
 * Runs one go of a recurring job, recording when it started and how it ended. A failure is
 * recorded and thrown on, so pg-boss retries it exactly as before.
 */
export async function trackRun(
  pool: pg.Pool,
  queue: string,
  /** The job itself; what it returns (its counts) is the job's own business. */
  run: () => Promise<unknown>,
): Promise<void> {
  await stamp(pool, queue, "last_started_at");
  try {
    await run();
  } catch (error) {
    await stamp(pool, queue, "last_failed_at");
    throw error;
  }
  await stamp(pool, queue, "last_succeeded_at");
}

export async function listScheduledRuns(pool: pg.Pool): Promise<ScheduledRun[]> {
  const { rows } = await pool.query<{
    queue: string;
    registered_at: Date;
    last_started_at: Date | null;
    last_succeeded_at: Date | null;
    last_failed_at: Date | null;
  }>(
    `SELECT queue, registered_at, last_started_at, last_succeeded_at, last_failed_at
     FROM scheduled_runs ORDER BY queue`,
  );
  return rows.map((row) => ({
    queue: row.queue,
    registeredAt: row.registered_at,
    lastStartedAt: row.last_started_at,
    lastSucceededAt: row.last_succeeded_at,
    lastFailedAt: row.last_failed_at,
  }));
}

/**
 * No success within the job's limit, counted from its last success or, before its first, from
 * when it was first scheduled. A queue this file doesn't know is never overdue.
 */
export function isOverdue(
  run: Pick<ScheduledRun, "queue" | "registeredAt" | "lastSucceededAt">,
  now: Date,
): boolean {
  const job = SCHEDULED_JOBS[run.queue];
  if (!job) return false;
  const since = run.lastSucceededAt ?? run.registeredAt;
  return now.getTime() - since.getTime() > job.overdueAfterMs;
}

/**
 * One look at every job on record, not only the ones this worker runs: a job the worker no
 * longer runs (a setting it needs went missing) is exactly the one to speak up about. Alerts
 * once when a job becomes overdue, and logs when it's back on time. The jobs that went overdue
 * in the same look share one alert: the email sends one per alert name per 15 minutes, so a
 * second alert straight after the first would only be counted, never named.
 * Remembered for this process only: a restarted worker says it again for a job still overdue.
 */
export function createScheduleCheck({
  pool,
  runsHere,
  alert = raiseAlert,
  now = () => new Date(),
}: {
  pool: pg.Pool;
  /** The queues this worker gave a worker to (registerJobs' answer). */
  runsHere: readonly string[];
  alert?: AlertFn;
  now?: () => Date;
}): () => Promise<void> {
  const alerted = new Set<string>();
  return async () => {
    const at = now();
    const newlyOverdue: ScheduledRun[] = [];
    for (const run of await listScheduledRuns(pool)) {
      if (isOverdue(run, at)) {
        if (alerted.has(run.queue)) continue;
        alerted.add(run.queue);
        newlyOverdue.push(run);
      } else if (alerted.delete(run.queue)) {
        logger.info("Scheduled job back on time", { queue: run.queue });
      }
    }
    if (newlyOverdue.length === 0) return;
    alert("scheduled-job-overdue", {
      jobs: newlyOverdue.map((run) => ({
        queue: run.queue,
        job: SCHEDULED_JOBS[run.queue]?.label,
        lastSucceededAt: run.lastSucceededAt?.toISOString() ?? null,
        lastFailedAt: run.lastFailedAt?.toISOString() ?? null,
        // false: this worker doesn't run the job at all, so a setting it needs is missing.
        runsHere: runsHere.includes(run.queue),
      })),
    });
  };
}

/**
 * Checks now, then every `intervalMs`, until stop() (the worker's shutdown). A failed check is
 * logged and the next one tried: watching must never take the worker down.
 */
export function startScheduleWatch(
  check: () => Promise<void>,
  intervalMs = SCHEDULE_CHECK_INTERVAL_MS,
): { stop: () => void } {
  const tick = () =>
    void check().catch((error: unknown) => {
      logger.warn("Scheduled-job check failed", { error });
    });
  tick();
  const timer = setInterval(tick, intervalMs);
  // Never the reason the process stays alive.
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
