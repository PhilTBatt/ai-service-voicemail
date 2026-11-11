// registerJobs under every mix of settings the worker can start with: 2^8 of them. Whatever is
// set, no queue gets two workers, what it says it runs is what it runs, and each recurring job
// is scheduled exactly when its worker is there (on UK time, its cron as jobs/queue.ts gives
// it). worker-jobs.test.ts covers the all-on and all-off ends; this covers everything between.
import { readFileSync } from "node:fs";
import type { PgBoss } from "pg-boss";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";
import { createAdminPool } from "./db/cross-tenant.ts";
import { createPool } from "./db/pool.ts";
import { SCHEDULED_JOBS } from "./db/scheduled-runs.ts";
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

const CRONS: Record<string, string> = {
  [queue.RECONCILE_VOICEMAILS_QUEUE]: queue.RECONCILE_VOICEMAILS_CRON,
  [queue.RECONCILE_CALLS_QUEUE]: queue.RECONCILE_CALLS_CRON,
  [queue.RETENTION_QUEUE]: queue.RETENTION_CRON,
  [queue.CHARGE_PERIODS_QUEUE]: queue.CHARGE_PERIODS_CRON,
};

/** Stands in for pg-boss: records each worker and schedule, and never runs a job. */
function recorder() {
  const worked: string[] = [];
  const handlers = new Map<string, (jobs: unknown[]) => Promise<unknown>>();
  const scheduled: { name: string; cron: string; data: unknown; options: unknown }[] = [];
  const boss = {
    work: (name: string, ...rest: unknown[]) => {
      worked.push(name);
      handlers.set(name, rest.at(-1) as (jobs: unknown[]) => Promise<unknown>);
      return Promise.resolve(`worker-${name}`);
    },
    schedule: (name: string, cron: string, data: unknown, options: unknown) => {
      scheduled.push({ name, cron, data, options });
      return Promise.resolve();
    },
    send: () => Promise.resolve(null),
  } as unknown as PgBoss;
  return { boss, worked, handlers, scheduled };
}

/** The settings the worker can start with, in groups that switch something on together. */
const GROUPS = {
  llm: ["ANTHROPIC_API_KEY"],
  twilio: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"],
  smsFrom: ["TWILIO_SMS_FROM"],
  signing: ["SIGNING_SECRET"],
  publicUrl: ["PUBLIC_BASE_URL"],
  email: ["POSTMARK_SERVER_TOKEN", "EMAIL_FROM"],
  payments: ["GOCARDLESS_ACCESS_TOKEN"],
} as const;
type Group = keyof typeof GROUPS | "admin";
const ALL_GROUPS: Group[] = [...(Object.keys(GROUPS) as (keyof typeof GROUPS)[]), "admin"];

function envWith(groups: ReadonlySet<Group>): Record<string, string> {
  const env: Record<string, string> = { ...MINIMAL_WORKER_ENV };
  for (const [group, names] of Object.entries(GROUPS)) {
    if (!groups.has(group as Group)) continue;
    for (const name of names) env[name] = STAND_IN_ENV[name];
  }
  return env;
}

async function register(groups: ReadonlySet<Group>) {
  const recorded = recorder();
  const config = loadConfig(envWith(groups));
  const queues = await registerJobs(
    { ...config, retellApiKey: config.retellApiKey ?? "" },
    { boss: recorded.boss, pool, admin: groups.has("admin") ? admin : null },
  );
  return { ...recorded, queues };
}

/**
 * What the worker should run with these settings, written from the rules worker-jobs.ts's
 * warnings state (and RUNBOOK section 16), not from its code: two readings that must agree.
 */
function expectedQueues(on: ReadonlySet<Group>): string[] {
  const has = (...groups: Group[]) => groups.every((group) => on.has(group));
  return [
    queue.SYNC_AGENT_QUEUE,
    queue.DEAD_LETTER_QUEUE,
    ...(has("llm") ? [queue.PROCESS_CALL_QUEUE] : []),
    ...(has("twilio", "smsFrom", "signing", "publicUrl")
      ? [
          queue.NOTIFY_EMERGENCY_QUEUE,
          queue.NOTIFY_SMS_QUEUE,
          queue.ONBOARDING_QUEUE,
          queue.OFFBOARDING_QUEUE,
        ]
      : []),
    ...(has("email", "signing", "publicUrl")
      ? [queue.NOTIFY_EMAIL_QUEUE, queue.BILLING_EMAIL_QUEUE]
      : []),
    ...(has("admin", "payments") ? [queue.CHARGE_PERIODS_QUEUE] : []),
    ...(has("admin") ? [queue.RECONCILE_CALLS_QUEUE] : []),
    ...(has("twilio") ? [queue.RECONCILE_VOICEMAILS_QUEUE] : []),
    ...(has("twilio", "admin") ? [queue.RETENTION_QUEUE] : []),
  ].sort();
}

/** Every subset of the groups. */
const COMBINATIONS: Set<Group>[] = Array.from(
  { length: 2 ** ALL_GROUPS.length },
  (_, mask) => new Set(ALL_GROUPS.filter((_, bit) => mask & (1 << bit))),
);

describe("registerJobs, under every mix of settings", () => {
  it("runs exactly the queues its settings allow, each once, and says so truthfully", async () => {
    expect(COMBINATIONS).toHaveLength(256);
    for (const groups of COMBINATIONS) {
      const label = [...groups].join("+") || "nothing";
      const { worked, queues, scheduled } = await register(groups);
      expect([...worked].sort(), label).toEqual(expectedQueues(groups));
      // One worker a queue: two would take its jobs twice as fast and break its policy.
      expect(new Set(worked).size, label).toBe(worked.length);
      // What it returns is what health and the overdue check believe it runs.
      expect([...queues].sort(), label).toEqual([...worked].sort());
      // A recurring job is scheduled exactly when it has a worker, and never twice.
      const recurring = worked.filter((name) => Object.hasOwn(SCHEDULED_JOBS, name)).sort();
      expect(scheduled.map((s) => s.name).sort(), label).toEqual(recurring);
    }
  });

  it("schedules each recurring job on its own cron, UK time, catching up a missed run once", async () => {
    const { scheduled } = await register(new Set(ALL_GROUPS));
    expect(scheduled).toHaveLength(Object.keys(SCHEDULED_JOBS).length);
    for (const { name, cron, data, options } of scheduled) {
      expect(cron, name).toBe(CRONS[name]);
      expect(data, name).toBeNull();
      expect(options, name).toEqual({ tz: "Europe/London", missed: "once" });
    }
  });

  it("always runs the dead-letter queue, so a job that fails every retry is always heard of", async () => {
    for (const groups of [new Set<Group>(), new Set(ALL_GROUPS)]) {
      const { worked } = await register(groups);
      expect(worked).toContain(queue.DEAD_LETTER_QUEUE);
    }
  });

  it("handles an empty batch on every queue that isn't a recurring job, doing nothing", async () => {
    // pg-boss can hand over an empty batch; the scheduled ones are left out because their
    // handlers record the run (db/scheduled-runs.test.ts owns those rows).
    const { handlers } = await register(new Set(ALL_GROUPS));
    for (const [name, handler] of handlers) {
      if (Object.hasOwn(SCHEDULED_JOBS, name) || name === queue.DEAD_LETTER_QUEUE) continue;
      await expect(handler([]), name).resolves.toBeUndefined();
    }
  });
});

describe("the recurring jobs' wiring (worker-jobs.ts)", () => {
  const source = readFileSync(new URL("./worker-jobs.ts", import.meta.url), "utf8");
  const constantFor = (name: string) =>
    Object.entries(queue).find(([key, value]) => key.endsWith("_QUEUE") && value === name)![0];

  // Without trackRun a job runs but is never recorded, and the overdue check alerts about a
  // job that is in fact running fine.
  it("records every run of every recurring job, under its own name", () => {
    for (const name of Object.keys(SCHEDULED_JOBS)) {
      const constant = constantFor(name);
      expect(source, constant).toMatch(
        new RegExp(`boss\\.work\\(${constant}, \\(\\) =>\\s+trackRun\\(pool, ${constant},`),
      );
    }
  });

  it("schedules nothing that isn't a recurring job the overdue check knows", () => {
    const scheduledConstants = [...source.matchAll(/boss\.schedule\(\s*([A-Z_]+_QUEUE)/g)].map(
      (m) => m[1],
    );
    expect(scheduledConstants.sort()).toEqual(Object.keys(SCHEDULED_JOBS).map(constantFor).sort());
  });
});
