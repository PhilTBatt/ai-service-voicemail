// The overdue rule's edges, without the database: each limit against its job's cron, the clock
// changes, a clock that runs ahead, and queue names that only look like jobs. Writing
// scheduled_runs stays in scheduled-runs.test.ts (one row per job, for the whole service).
import { describe, expect, it } from "vitest";
import {
  CHARGE_PERIODS_CRON,
  CHARGE_PERIODS_QUEUE,
  RECONCILE_CALLS_CRON,
  RECONCILE_CALLS_QUEUE,
  RECONCILE_VOICEMAILS_CRON,
  RECONCILE_VOICEMAILS_QUEUE,
  RETENTION_CRON,
  RETENTION_QUEUE,
} from "../jobs/queue.ts";
import {
  SCHEDULE_CHECK_INTERVAL_MS,
  SCHEDULED_JOBS,
  isOverdue,
  isScheduledJob,
} from "./scheduled-runs.ts";
import {
  HEARTBEAT_INTERVAL_MS,
  SYNC_WAITING_AFTER_MS,
  WORKER_DOWN_AFTER_MS,
  workerState,
} from "./worker-heartbeat.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const CRONS: Record<string, string> = {
  [RECONCILE_VOICEMAILS_QUEUE]: RECONCILE_VOICEMAILS_CRON,
  [RECONCILE_CALLS_QUEUE]: RECONCILE_CALLS_CRON,
  [RETENTION_QUEUE]: RETENTION_CRON,
  [CHARGE_PERIODS_QUEUE]: CHARGE_PERIODS_CRON,
};

/**
 * The longest gap between two runs of a cron, in UK time, for the two shapes used here: every
 * N minutes ("*\/15", "7-59/15") or once a day ("30 3 * * *"). A day is 25 hours when the clocks
 * go back, so that's the daily gap to allow.
 */
function longestGapMs(cron: string): number {
  const [minute, hour, ...rest] = cron.split(" ");
  expect(rest).toEqual(["*", "*", "*"]);
  if (hour === "*") {
    const step = /\/(\d+)$/.exec(minute!)?.[1];
    expect(step, cron).toBeDefined();
    return Number(step) * MINUTE;
  }
  expect(minute, cron).toMatch(/^\d+$/);
  expect(hour, cron).toMatch(/^\d+$/);
  return 25 * HOUR;
}

describe("SCHEDULED_JOBS against the crons", () => {
  it("has a cron for every recurring job, and a recurring job for every cron", () => {
    expect(Object.keys(SCHEDULED_JOBS).sort()).toEqual(Object.keys(CRONS).sort());
  });

  // scheduled-runs.ts: four missed runs for the 15-minute jobs; the longest (25-hour) day and
  // an hour's slack for the daily ones.
  it.each(Object.keys(CRONS))(
    "%s: allows its longest gap and some slack before it's overdue",
    (queue) => {
      const gap = longestGapMs(CRONS[queue]!);
      const needed = gap < HOUR ? 4 * gap : gap + HOUR;
      expect(SCHEDULED_JOBS[queue]!.overdueAfterMs).toBeGreaterThanOrEqual(needed);
      // And never so long that a stopped job goes a whole extra day unnoticed.
      expect(SCHEDULED_JOBS[queue]!.overdueAfterMs).toBeLessThan(gap + 24 * HOUR);
    },
  );

  it.each(Object.keys(CRONS))("%s: says in its label when it runs, as its cron does", (queue) => {
    const label = SCHEDULED_JOBS[queue]!.label;
    const [minute, hour] = CRONS[queue]!.split(" ");
    if (hour === "*") {
      expect(label).toContain(`every ${/\/(\d+)$/.exec(minute!)![1]} minutes`);
    } else {
      expect(label).toContain(`${hour!.padStart(2, "0")}:${minute!.padStart(2, "0")} daily`);
    }
  });

  it("is overdue later than the check that looks for it runs, so a check never misses it by much", () => {
    for (const { overdueAfterMs } of Object.values(SCHEDULED_JOBS)) {
      expect(SCHEDULE_CHECK_INTERVAL_MS).toBeLessThan(overdueAfterMs);
    }
  });
});

describe("isOverdue at the edges", () => {
  const registeredAt = new Date("2026-01-01T00:00:00Z");

  it("isn't overdue when the last success is in the future (the database's clock ahead of the worker's)", () => {
    const now = new Date("2026-11-11T12:00:00Z");
    for (const queue of Object.keys(SCHEDULED_JOBS)) {
      expect(
        isOverdue({ queue, registeredAt, lastSucceededAt: new Date(now.getTime() + HOUR) }, now),
      ).toBe(false);
    }
  });

  // The 15-minute jobs count real time, so the hour that's lost or repeated changes nothing.
  it.each([
    ["the clocks go forward", "2026-03-29T00:30:00Z"],
    ["the clocks go back", "2026-10-25T00:30:00Z"],
  ])("gives the 15-minute jobs exactly an hour across the night %s", (_label, iso) => {
    const succeeded = new Date(iso);
    const run = { queue: RECONCILE_VOICEMAILS_QUEUE, registeredAt, lastSucceededAt: succeeded };
    expect(isOverdue(run, new Date(succeeded.getTime() + HOUR))).toBe(false);
    expect(isOverdue(run, new Date(succeeded.getTime() + HOUR + 1))).toBe(true);
  });

  it("keeps the daily jobs on time over the 23-hour day when the clocks go forward", () => {
    // 03:30 GMT on 28 March, then 03:30 BST on 29 March: 23 hours apart.
    const before = new Date("2026-03-28T03:30:00Z");
    const after = new Date("2026-03-29T02:30:00Z");
    expect(after.getTime() - before.getTime()).toBe(23 * HOUR);
    expect(
      isOverdue({ queue: RETENTION_QUEUE, registeredAt, lastSucceededAt: before }, after),
    ).toBe(false);
  });

  it("counts from the last success, not from a later failure", () => {
    const now = new Date("2026-11-11T12:00:00Z");
    // A run that keeps failing is a stopped job too: only a success resets the clock.
    expect(
      isOverdue(
        {
          queue: RECONCILE_CALLS_QUEUE,
          registeredAt,
          lastSucceededAt: new Date(now.getTime() - 2 * HOUR),
        },
        now,
      ),
    ).toBe(true);
  });

  it.each(["__proto__", "constructor", "toString", "hasOwnProperty", "", "RETENTION"])(
    "never calls %j a recurring job, nor overdue",
    (queue) => {
      expect(isScheduledJob(queue)).toBe(false);
      expect(
        isOverdue({ queue, registeredAt: new Date(0), lastSucceededAt: null }, new Date()),
      ).toBe(false);
    },
  );

  it("knows each recurring job by its exact name", () => {
    for (const queue of Object.keys(SCHEDULED_JOBS)) expect(isScheduledJob(queue)).toBe(true);
  });
});

describe("the worker's check-in timings", () => {
  it("calls a worker down only after it has missed four check-ins", () => {
    expect(WORKER_DOWN_AFTER_MS).toBe(4 * HEARTBEAT_INTERVAL_MS);
  });

  it("waits longer for a sync than for the worker, so a waiting sync means nothing ran", () => {
    expect(SYNC_WAITING_AFTER_MS).toBeGreaterThan(WORKER_DOWN_AFTER_MS);
  });

  it("calls a check-in from the future running (the clocks disagree, the worker is there)", () => {
    const now = new Date("2026-11-11T12:00:00Z");
    expect(workerState({ seenAt: new Date(now.getTime() + MINUTE) }, now).state).toBe("running");
  });

  it("calls a worker seen a year ago down, with when it was seen", () => {
    const now = new Date("2026-11-11T12:00:00Z");
    const seenAt = new Date("2025-11-11T12:00:00Z");
    expect(workerState({ seenAt }, now)).toEqual({ state: "down", seenAt });
  });
});
