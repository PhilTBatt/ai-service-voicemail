// What startQueue leaves in the database, read back from pg-boss: every queue the code names
// exists, every one but the dead-letter queue sends a job that fails every retry there (where
// it raises an alert), and each has the retry, expiry and policy its comment promises. A queue
// without a dead-letter queue would drop its failures silently.
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SCHEDULED_JOBS } from "../db/scheduled-runs.ts";
import { TEST_DATABASE_URL } from "../testing/databases.ts";
import * as queue from "./queue.ts";
import { createQueue, startQueue, startQueueWhenReachable } from "./queue.ts";

/** Every queue jobs/queue.ts defines: a new one is checked here without being listed. */
const ALL_QUEUES = Object.entries(queue)
  .filter(([name, value]) => name.endsWith("_QUEUE") && typeof value === "string")
  .map(([, value]) => value as string);
const WORK_QUEUES = ALL_QUEUES.filter((name) => name !== queue.DEAD_LETTER_QUEUE);

let boss: PgBoss;

beforeAll(async () => {
  boss = await startQueue(TEST_DATABASE_URL);
}, 30_000);

afterAll(async () => {
  await boss.stop({ close: true, graceful: false });
});

const settingsOf = async (name: string) => {
  const found = await boss.getQueue(name);
  if (!found) throw new Error(`queue ${name} doesn't exist`);
  return found;
};

describe("startQueueWhenReachable (the API and the worker at start-up)", () => {
  it("keeps trying a database it can't reach, and stops cleanly when told to", async () => {
    // Nothing listens on port 1: every attempt is refused at once, as in a restart or failover.
    const down = createQueue("postgres://callmate_app@127.0.0.1:1/callmate?sslmode=disable");
    const stopping = new AbortController();
    const outcome = startQueueWhenReachable(down, { signal: stopping.signal, pauseMs: 50 });
    // Still trying after a couple of seconds: it hasn't thrown or given up.
    const early = await Promise.race([
      outcome,
      new Promise<"still trying">((resolve) => setTimeout(() => resolve("still trying"), 2_000)),
    ]);
    expect(early).toBe("still trying");
    // A shutdown: the signal, then stopping pg-boss, which cancels its wait between attempts.
    stopping.abort();
    await down.stop({ close: true, graceful: false });
    expect(await outcome).toBe("stopped");
  }, 30_000);

  it("starts, with every queue made, once the database answers", async () => {
    const up = createQueue(TEST_DATABASE_URL);
    try {
      expect(await startQueueWhenReachable(up)).toBe("started");
      for (const name of ALL_QUEUES) expect(await up.getQueue(name), name).toBeTruthy();
    } finally {
      await up.stop({ close: true, graceful: false });
    }
  }, 30_000);
});

describe("startQueue", () => {
  it("finds every queue the code names", () => {
    expect(ALL_QUEUES).toContain(queue.DEAD_LETTER_QUEUE);
    expect(ALL_QUEUES.length).toBeGreaterThanOrEqual(13);
    expect(new Set(ALL_QUEUES).size).toBe(ALL_QUEUES.length);
  });

  it("creates every queue, so no worker or send ever meets one that isn't there", async () => {
    for (const name of ALL_QUEUES) expect(await boss.getQueue(name), name).not.toBeNull();
  });

  it.each(WORK_QUEUES)("%s: dead-letters a job that fails every retry", async (name) => {
    const settings = await settingsOf(name);
    expect(settings.deadLetter).toBe(queue.DEAD_LETTER_QUEUE);
    expect(settings.retryLimit).toBeGreaterThanOrEqual(2);
    expect(settings.expireInSeconds).toBeGreaterThan(0);
  });

  it("gives the dead-letter queue no dead-letter queue of its own (no loop)", async () => {
    expect((await settingsOf(queue.DEAD_LETTER_QUEUE)).deadLetter ?? null).toBeNull();
  });

  // Idempotency (CLAUDE.md): jobs keyed by a provider's ID, at most one queued or active.
  it.each([
    queue.SYNC_AGENT_QUEUE,
    queue.PROCESS_CALL_QUEUE,
    queue.NOTIFY_SMS_QUEUE,
    queue.NOTIFY_EMAIL_QUEUE,
    queue.NOTIFY_EMERGENCY_QUEUE,
    queue.ONBOARDING_QUEUE,
    queue.OFFBOARDING_QUEUE,
    queue.BILLING_EMAIL_QUEUE,
  ])("%s: holds one job per key, queued or active", async (name) => {
    expect((await settingsOf(name)).policy).toBe("exclusive");
  });

  it.each(Object.keys(SCHEDULED_JOBS))("%s: never runs twice at once", async (name) => {
    expect((await settingsOf(name)).policy).toBe("singleton");
  });

  it("retries an emergency text sooner than any other text or email", async () => {
    const emergency = await settingsOf(queue.NOTIFY_EMERGENCY_QUEUE);
    for (const name of [queue.NOTIFY_SMS_QUEUE, queue.NOTIFY_EMAIL_QUEUE]) {
      expect(emergency.retryDelay!, name).toBeLessThan((await settingsOf(name)).retryDelay!);
    }
    expect(emergency.retryDelay).toBeLessThanOrEqual(10);
  });

  it("keeps waiting email jobs 30 days, where email isn't set up yet", async () => {
    for (const name of [queue.NOTIFY_EMAIL_QUEUE, queue.BILLING_EMAIL_QUEUE]) {
      expect((await settingsOf(name)).retentionSeconds, name).toBe(30 * 24 * 60 * 60);
    }
  });

  it("gives a business's data deletion an hour before it's retried", async () => {
    expect((await settingsOf(queue.OFFBOARDING_QUEUE)).expireInSeconds).toBe(3600);
  });

  it("is safe to start again: a second start changes nothing and fails nothing", async () => {
    const before = await Promise.all(ALL_QUEUES.map(settingsOf));
    const again = await startQueue(TEST_DATABASE_URL);
    await again.stop({ close: true, graceful: false });
    const after = await Promise.all(ALL_QUEUES.map(settingsOf));
    const settings = (q: Awaited<ReturnType<typeof settingsOf>>) => ({
      name: q.name,
      policy: q.policy,
      retryLimit: q.retryLimit,
      retryDelay: q.retryDelay,
      retryBackoff: q.retryBackoff,
      expireInSeconds: q.expireInSeconds,
      retentionSeconds: q.retentionSeconds,
      deadLetter: q.deadLetter,
    });
    expect(after.map(settings)).toEqual(before.map(settings));
  }, 30_000);
});
