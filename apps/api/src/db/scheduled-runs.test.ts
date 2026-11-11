// Every test that writes scheduled_runs for a real queue lives in this file: the table is one
// row per job for the whole service, and test files run in parallel. Others only read it.
import type pg from "pg";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  CHARGE_PERIODS_QUEUE,
  NOTIFY_SMS_QUEUE,
  RECONCILE_CALLS_QUEUE,
  RECONCILE_VOICEMAILS_QUEUE,
  RETENTION_QUEUE,
} from "../jobs/queue.ts";
import { logger } from "../logger.ts";
import { TEST_DATABASE_URL } from "../testing/databases.ts";
import { createPool } from "./pool.ts";
import {
  SCHEDULED_JOBS,
  createScheduleCheck,
  isOverdue,
  listScheduledRuns,
  registerScheduledRuns,
  startScheduleWatch,
  trackRun,
} from "./scheduled-runs.ts";

// The app role, as the worker and the API connect.
const pool = createPool(TEST_DATABASE_URL);

afterAll(async () => {
  await pool.end();
});

const HOUR_MS = 60 * 60_000;

describe("isOverdue", () => {
  const now = new Date("2026-10-25T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("gives the every-15-minutes jobs an hour, four missed runs", () => {
    const run = { queue: RECONCILE_CALLS_QUEUE, registeredAt: ago(30 * 24 * HOUR_MS) };
    expect(isOverdue({ ...run, lastSucceededAt: ago(HOUR_MS) }, now)).toBe(false);
    expect(isOverdue({ ...run, lastSucceededAt: ago(HOUR_MS + 1) }, now)).toBe(true);
  });

  it("gives the daily jobs 26 hours, so the day the clocks go back (25 hours) is on time", () => {
    // 2026-10-25 is the day the UK's clocks go back: 06:00 on the 24th to 06:00 on the 25th,
    // UK time, is 25 hours.
    const charged = new Date("2026-10-24T05:00:00Z"); // 06:00 BST
    const nextMorning = new Date("2026-10-25T06:00:00Z"); // 06:00 GMT
    const run = { queue: CHARGE_PERIODS_QUEUE, registeredAt: ago(30 * 24 * HOUR_MS) };
    expect(nextMorning.getTime() - charged.getTime()).toBe(25 * HOUR_MS);
    expect(isOverdue({ ...run, lastSucceededAt: charged }, nextMorning)).toBe(false);
    expect(isOverdue({ ...run, lastSucceededAt: ago(26 * HOUR_MS) }, now)).toBe(false);
    expect(isOverdue({ ...run, lastSucceededAt: ago(26 * HOUR_MS + 1) }, now)).toBe(true);
  });

  it("counts from when the job was first scheduled until its first success", () => {
    expect(
      isOverdue({ queue: RETENTION_QUEUE, registeredAt: ago(HOUR_MS), lastSucceededAt: null }, now),
    ).toBe(false);
    expect(
      isOverdue(
        { queue: RETENTION_QUEUE, registeredAt: ago(27 * HOUR_MS), lastSucceededAt: null },
        now,
      ),
    ).toBe(true);
  });

  it("is never true of a queue that isn't a recurring job", () => {
    expect(
      isOverdue(
        { queue: NOTIFY_SMS_QUEUE, registeredAt: ago(1000 * HOUR_MS), lastSucceededAt: null },
        now,
      ),
    ).toBe(false);
  });

  it("knows all four recurring jobs, each with words for the Admin page", () => {
    expect(Object.keys(SCHEDULED_JOBS).sort()).toEqual(
      [
        CHARGE_PERIODS_QUEUE,
        RECONCILE_CALLS_QUEUE,
        RECONCILE_VOICEMAILS_QUEUE,
        RETENTION_QUEUE,
      ].sort(),
    );
  });
});

describe("the runs on record", () => {
  // The global setup empties the table at the start of a run; the app role can't.
  const row = async (queue: string) =>
    (await listScheduledRuns(pool)).find((run) => run.queue === queue);

  it("registers the recurring jobs a worker runs, once, and nothing else", async () => {
    await registerScheduledRuns(pool, [RETENTION_QUEUE, NOTIFY_SMS_QUEUE]);
    const first = await row(RETENTION_QUEUE);
    expect(first).toBeDefined();
    expect(await row(NOTIFY_SMS_QUEUE)).toBeUndefined();

    // A restart doesn't reset the clock: a broken job can't be hidden by restarting.
    await registerScheduledRuns(pool, [RETENTION_QUEUE]);
    expect((await row(RETENTION_QUEUE))?.registeredAt).toEqual(first!.registeredAt);
  });

  it("records a run's start and its success", async () => {
    const run = vi.fn(() => Promise.resolve());
    await trackRun(pool, RETENTION_QUEUE, run);
    expect(run).toHaveBeenCalledTimes(1);
    const after = await row(RETENTION_QUEUE);
    expect(after?.lastStartedAt).toBeInstanceOf(Date);
    expect(after?.lastSucceededAt).toBeInstanceOf(Date);
    expect(after!.lastSucceededAt!.getTime()).toBeGreaterThanOrEqual(
      after!.lastStartedAt!.getTime(),
    );
  });

  it("records a failure and throws it on, so pg-boss retries as before", async () => {
    await trackRun(pool, CHARGE_PERIODS_QUEUE, () => Promise.resolve());
    const succeeded = (await row(CHARGE_PERIODS_QUEUE))?.lastSucceededAt;

    await expect(
      trackRun(pool, CHARGE_PERIODS_QUEUE, () => Promise.reject(new Error("GoCardless down"))),
    ).rejects.toThrow("GoCardless down");
    const after = await row(CHARGE_PERIODS_QUEUE);
    expect(after?.lastFailedAt).toBeInstanceOf(Date);
    expect(after?.lastSucceededAt).toEqual(succeeded);
  });

  it("still runs the job when the record can't be written", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    const broken = { query: () => Promise.reject(new Error("database restarting")) };
    const run = vi.fn(() => Promise.resolve());
    await trackRun(broken as unknown as pg.Pool, RETENTION_QUEUE, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("Couldn't record a scheduled run", expect.any(Object));
    warn.mockRestore();
  });

  it("lets the app role record runs but not delete them", async () => {
    await registerScheduledRuns(pool, [RETENTION_QUEUE]);
    await expect(pool.query("DELETE FROM scheduled_runs")).rejects.toThrow(/permission denied/);
  });
});

describe("the overdue check", () => {
  const setSucceeded = (queue: string, hoursAgo: number) =>
    pool.query(
      `INSERT INTO scheduled_runs (queue, registered_at, last_succeeded_at)
       VALUES ($1, now() - interval '30 days', now() - make_interval(hours => $2))
       ON CONFLICT (queue) DO UPDATE SET last_succeeded_at = EXCLUDED.last_succeeded_at`,
      [queue, hoursAgo],
    );

  it("raises scheduled-job-overdue once per stoppage, naming every job in one alert, and re-arms", async () => {
    await setSucceeded(RECONCILE_CALLS_QUEUE, 0);
    await setSucceeded(CHARGE_PERIODS_QUEUE, 0);
    const alert = vi.fn();
    const info = vi.spyOn(logger, "info").mockImplementation(() => logger);
    const check = createScheduleCheck({
      pool,
      runsHere: [RECONCILE_CALLS_QUEUE],
      alert,
    });
    /** The queues each alert named, in order. Every alert is this one. */
    const alerted = () =>
      alert.mock.calls.map(([name, details]) => {
        expect(name).toBe("scheduled-job-overdue");
        return (details as { jobs: { queue: string }[] }).jobs.map((job) => job.queue).sort();
      });

    await check();
    expect(alert).not.toHaveBeenCalled();

    // Two hours without a reconciliation: overdue. Two days without a billing run, from a
    // worker that doesn't run billing at all (its settings went missing): overdue too. One
    // alert names both: the email sends one per alert name per 15 minutes, so a second alert
    // straight after would only be counted.
    await setSucceeded(RECONCILE_CALLS_QUEUE, 2);
    await setSucceeded(CHARGE_PERIODS_QUEUE, 48);
    await check();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith("scheduled-job-overdue", {
      jobs: expect.arrayContaining([
        expect.objectContaining({
          queue: RECONCILE_CALLS_QUEUE,
          job: SCHEDULED_JOBS[RECONCILE_CALLS_QUEUE]!.label,
          runsHere: true,
        }),
        expect.objectContaining({ queue: CHARGE_PERIODS_QUEUE, runsHere: false }),
      ]) as unknown,
    });
    expect(alerted()).toEqual([[CHARGE_PERIODS_QUEUE, RECONCILE_CALLS_QUEUE].sort()]);

    // Still overdue ten minutes later: no second alert.
    await check();
    expect(alert).toHaveBeenCalledTimes(1);

    // The reconciliation runs again: back on time, logged. Stopping again alerts again, for it
    // alone: billing is still the same stoppage, already said.
    await trackRun(pool, RECONCILE_CALLS_QUEUE, () => Promise.resolve());
    await check();
    expect(info).toHaveBeenCalledWith("Scheduled job back on time", {
      queue: RECONCILE_CALLS_QUEUE,
    });
    await setSucceeded(RECONCILE_CALLS_QUEUE, 3);
    await check();
    expect(alerted()).toEqual([
      [CHARGE_PERIODS_QUEUE, RECONCILE_CALLS_QUEUE].sort(),
      [RECONCILE_CALLS_QUEUE],
    ]);
    info.mockRestore();

    // Leave both on time for anything that reads the table afterwards.
    await setSucceeded(RECONCILE_CALLS_QUEUE, 0);
    await setSucceeded(CHARGE_PERIODS_QUEUE, 0);
  });
});

describe("startScheduleWatch", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("checks at once, then on every interval, until stopped", async () => {
    vi.useFakeTimers();
    const check = vi.fn(() => Promise.resolve());
    const watch = startScheduleWatch(check, 60_000);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(check).toHaveBeenCalledTimes(4);
    watch.stop();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(check).toHaveBeenCalledTimes(4);
  });

  it("logs a failed check and carries on, so watching never stops the worker", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    const check = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("database restarting"))
      .mockResolvedValue(undefined);
    const watch = startScheduleWatch(check, 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    watch.stop();
    expect(check).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith("Scheduled-job check failed", expect.any(Object));
    warn.mockRestore();
  });
});
