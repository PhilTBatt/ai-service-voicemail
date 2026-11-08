// The worker's check-in (BUILD_PLAN Step 14). The worker writes the time every 30 seconds; the
// health panel, GET /healthz/worker and npm run demo:profile read it to tell a worker that's
// down from one that's busy. Not tenant data: one row for the whole service.
import type pg from "pg";
import { logger } from "../logger.ts";

/** How often the worker checks in. */
export const HEARTBEAT_INTERVAL_MS = 30_000;
/**
 * Four missed check-ins: down, not busy. The check-in runs on a timer, so a job waiting on the
 * network or the database doesn't hold it up.
 */
export const WORKER_DOWN_AFTER_MS = 2 * 60_000;

/** A sync takes seconds when a worker is running; one still waiting after this, nothing ran. */
export const SYNC_WAITING_AFTER_MS = 5 * 60_000;

export interface Heartbeat {
  seenAt: Date;
  /** When the worker that last checked in started. */
  startedAt: Date;
}

export type WorkerState =
  { state: "running"; seenAt: Date } | { state: "down"; seenAt: Date } | { state: "never" };

export async function recordHeartbeat(pool: pg.Pool, startedAt: Date): Promise<void> {
  await pool.query(
    `INSERT INTO worker_heartbeat (seen_at, started_at) VALUES (now(), $1)
     ON CONFLICT (id) DO UPDATE SET seen_at = now(), started_at = EXCLUDED.started_at`,
    [startedAt],
  );
}

export async function lastHeartbeat(pool: pg.Pool): Promise<Heartbeat | null> {
  const { rows } = await pool.query<{ seen_at: Date; started_at: Date }>(
    "SELECT seen_at, started_at FROM worker_heartbeat",
  );
  const row = rows[0];
  return row ? { seenAt: row.seen_at, startedAt: row.started_at } : null;
}

/** Running if it checked in within WORKER_DOWN_AFTER_MS of `now`. */
export function workerState(beat: Pick<Heartbeat, "seenAt"> | null, now: Date): WorkerState {
  if (!beat) return { state: "never" };
  const age = now.getTime() - beat.seenAt.getTime();
  return { state: age <= WORKER_DOWN_AFTER_MS ? "running" : "down", seenAt: beat.seenAt };
}

/**
 * Checks in now, then every `intervalMs`, until stop() (the worker's shutdown). A failed check-in
 * is logged and the next one tried: the heartbeat must never take the worker down.
 */
export function startHeartbeat(
  record: () => Promise<void>,
  intervalMs = HEARTBEAT_INTERVAL_MS,
): { stop: () => void } {
  const beat = () =>
    void record().catch((error: unknown) => {
      logger.warn("Worker check-in failed", { error });
    });
  beat();
  const timer = setInterval(beat, intervalMs);
  // Never the reason the process stays alive.
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
