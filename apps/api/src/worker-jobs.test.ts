import type { PgBoss } from "pg-boss";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";
import { createAdminPool } from "./db/cross-tenant.ts";
import { createPool } from "./db/pool.ts";
import * as queue from "./jobs/queue.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "./testing/databases.ts";
import { MINIMAL_WORKER_ENV, STAND_IN_ENV } from "./testing/stand-in-env.ts";
import { registerJobs } from "./worker-jobs.ts";

// Pools that connect lazily: building the job list never queries them.
const pool = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);

afterAll(async () => {
  await Promise.all([pool.end(), admin.end()]);
});

/** Every queue jobs/queue.ts defines: a new one can't be forgotten here. */
const ALL_QUEUES = Object.entries(queue)
  .filter(([name, value]) => name.endsWith("_QUEUE") && typeof value === "string")
  .map(([, value]) => value as string);

/** Stands in for pg-boss: records each worker and schedule, and never runs a job. */
function recorder() {
  const worked: string[] = [];
  const scheduled: { name: string; tz: string | undefined }[] = [];
  const boss = {
    work: (name: string) => {
      worked.push(name);
      return Promise.resolve(`worker-${name}`);
    },
    schedule: (name: string, _cron: string, _data: unknown, options?: { tz?: string }) => {
      scheduled.push({ name, tz: options?.tz });
      return Promise.resolve();
    },
    send: () => Promise.resolve(null),
  } as unknown as PgBoss;
  return { boss, worked, scheduled };
}

function configFrom(env: Record<string, string>) {
  const config = loadConfig(env);
  return { ...config, retellApiKey: config.retellApiKey ?? "" };
}

describe("registerJobs", () => {
  it("gives every queue a worker once every provider is set up", async () => {
    const { boss, worked } = recorder();
    const queues = await registerJobs(configFrom(STAND_IN_ENV), { boss, pool, admin });
    expect(new Set(worked)).toEqual(new Set(ALL_QUEUES));
    expect(new Set(queues)).toEqual(new Set(ALL_QUEUES));
    expect(worked).toHaveLength(ALL_QUEUES.length); // one worker each, never two
  });

  it("runs the four recurring jobs on UK time", async () => {
    const { boss, scheduled } = recorder();
    await registerJobs(configFrom(STAND_IN_ENV), { boss, pool, admin });
    expect(scheduled).toEqual(
      expect.arrayContaining([
        { name: queue.RECONCILE_CALLS_QUEUE, tz: "Europe/London" },
        { name: queue.RECONCILE_VOICEMAILS_QUEUE, tz: "Europe/London" },
        { name: queue.RETENTION_QUEUE, tz: "Europe/London" },
        { name: queue.CHARGE_PERIODS_QUEUE, tz: "Europe/London" },
      ]),
    );
    expect(scheduled).toHaveLength(4);
  });

  it("leaves every other queue's jobs waiting when only Retell is set up", async () => {
    const { boss, worked, scheduled } = recorder();
    const queues = await registerJobs(configFrom(MINIMAL_WORKER_ENV), {
      boss,
      pool,
      admin: null,
    });
    expect(new Set(worked)).toEqual(new Set([queue.SYNC_AGENT_QUEUE, queue.DEAD_LETTER_QUEUE]));
    expect(new Set(queues)).toEqual(new Set(worked));
    expect(scheduled).toEqual([]);
  });
});
