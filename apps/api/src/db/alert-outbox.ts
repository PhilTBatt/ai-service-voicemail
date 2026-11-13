// The alert emails waiting to go (migration 20261113150000; alert-email.ts sends them). Every
// time is passed in rather than read from the database's clock, so the throttle and the
// back-off are the sender's own, and tests can set them.
import type pg from "pg";

/** One window's waiting alerts, claimed by this process to email. */
export interface ClaimedAlert {
  key: string;
  alert: string;
  details: Record<string, unknown>;
  raisedAt: Date;
  /** How many alerts the email carries: the newest, and the ones it counts as "more". */
  unsent: number;
}

/** How long a claim lasts: well past a send's own 15-second time limit. */
export const ALERT_CLAIM_MS = 2 * 60_000;
/** After a failed send, the wait before the next: it doubles each time, up to the most. */
export const ALERT_RETRY_FIRST_MS = 60_000;
export const ALERT_RETRY_MAX_MS = 15 * 60_000;
/** A window with nothing waiting is kept this long after its email, then deleted. */
export const ALERT_KEEP_MS = 24 * 60 * 60_000;

/** Adds one alert to its window: the newest details, one more waiting. */
export async function recordAlert(
  pool: pg.Pool,
  alert: { key: string; alert: string; details: Record<string, unknown>; at: Date },
): Promise<void> {
  await pool.query(
    `INSERT INTO alert_outbox (throttle_key, alert, details, raised_at, unsent, waiting_since)
     VALUES ($1, $2, $3, $4, 1, $4)
     ON CONFLICT (throttle_key) DO UPDATE SET
       alert = EXCLUDED.alert,
       details = EXCLUDED.details,
       raised_at = EXCLUDED.raised_at,
       unsent = alert_outbox.unsent + 1,
       waiting_since = CASE WHEN alert_outbox.unsent = 0 THEN EXCLUDED.raised_at
                            ELSE alert_outbox.waiting_since END`,
    [alert.key, alert.alert, alert.details, alert.at],
  );
}

/**
 * Claims the windows due an email: something waiting, the throttle's interval passed since the
 * last, no back-off running, and no other process holding it. The longest-waiting first. With
 * `key`, only that window (an alert just raised); without, every one (the minute's sweep).
 */
export async function claimDueAlerts(
  pool: pg.Pool,
  { at, minIntervalMs, key }: { at: Date; minIntervalMs: number; key?: string },
): Promise<ClaimedAlert[]> {
  const { rows } = await pool.query<{
    throttle_key: string;
    alert: string;
    details: Record<string, unknown>;
    raised_at: Date;
    unsent: number;
    waiting_since: Date;
  }>(
    `UPDATE alert_outbox o SET claimed_until = $1::timestamptz + $3::int * interval '1 millisecond'
     FROM (
       SELECT throttle_key FROM alert_outbox
       WHERE unsent > 0
         AND (sent_at IS NULL OR sent_at <= $1::timestamptz - $2::int * interval '1 millisecond')
         AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
         AND (claimed_until IS NULL OR claimed_until <= $1)
         AND ($4::text IS NULL OR throttle_key = $4)
       ORDER BY waiting_since, throttle_key
       FOR UPDATE SKIP LOCKED
     ) due
     WHERE o.throttle_key = due.throttle_key
     RETURNING o.throttle_key, o.alert, o.details, o.raised_at, o.unsent, o.waiting_since`,
    [at, minIntervalMs, ALERT_CLAIM_MS, key ?? null],
  );
  // UPDATE ... RETURNING doesn't keep the inner order: put it back.
  return rows
    .map((row) => ({
      key: row.throttle_key,
      alert: row.alert,
      details: row.details,
      raisedAt: row.raised_at,
      unsent: row.unsent,
      waitingSince: row.waiting_since,
    }))
    .sort(
      (a, b) => a.waitingSince.getTime() - b.waitingSince.getTime() || a.key.localeCompare(b.key),
    )
    .map(({ waitingSince: _waitingSince, ...claimed }) => claimed);
}

/**
 * The email went (or the allowlist turned it away for good): its window starts now, and the
 * alerts it carried are done. Any raised while it was on its way stay waiting.
 */
export async function markAlertSent(
  pool: pg.Pool,
  { key, carried, at }: { key: string; carried: number; at: Date },
): Promise<void> {
  await pool.query(
    `UPDATE alert_outbox SET
       sent_at = $3::timestamptz, unsent = greatest(unsent - $2::int, 0),
       waiting_since = CASE WHEN unsent - $2::int > 0 THEN $3::timestamptz ELSE NULL END,
       failures = 0, next_attempt_at = NULL, claimed_until = NULL
     WHERE throttle_key = $1`,
    [key, carried, at],
  );
}

/** The send failed: try again after 1 minute, then 2, 4, 8, and every 15 at most. */
export async function markAlertFailed(
  pool: pg.Pool,
  { key, at }: { key: string; at: Date },
): Promise<void> {
  await pool.query(
    `UPDATE alert_outbox SET
       failures = failures + 1,
       next_attempt_at = $2::timestamptz
         + least($3::bigint * power(2, failures)::bigint, $4::bigint) * interval '1 millisecond',
       claimed_until = NULL
     WHERE throttle_key = $1`,
    [key, at, ALERT_RETRY_FIRST_MS, ALERT_RETRY_MAX_MS],
  );
}

/** Lets a claimed window go without sending, as if it had never been claimed. */
export async function releaseAlert(pool: pg.Pool, key: string): Promise<void> {
  await pool.query("UPDATE alert_outbox SET claimed_until = NULL WHERE throttle_key = $1", [key]);
}

/** Deletes windows with nothing waiting whose last email was over a day ago. */
export async function pruneSentAlerts(pool: pg.Pool, at: Date): Promise<number> {
  const result = await pool.query(
    `DELETE FROM alert_outbox
     WHERE unsent = 0 AND sent_at < $1::timestamptz - $2::int * interval '1 millisecond'`,
    [at, ALERT_KEEP_MS],
  );
  return result.rowCount ?? 0;
}
