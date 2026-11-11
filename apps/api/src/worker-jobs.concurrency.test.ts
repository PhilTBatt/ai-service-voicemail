// The worker's own job registration (worker-jobs.ts), at the concurrency WORK_OPTIONS gives it,
// working through a batch of calls against the database with a fake for every outside service:
// the calls run side by side, each is processed once and each message sent once, however often
// its jobs are queued, and no job fails waiting for a connection at the pool sizes production
// uses (db/pool.ts).
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { PgBoss, SendOptions, WorkHandler, WorkOptions } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";
import { gasScript } from "./core/scripts.ts";
import { verifyCallLink } from "./core/signed-links.ts";
import { createAdminPool, createTenant } from "./db/cross-tenant.ts";
import { createPool } from "./db/pool.ts";
import {
  NOTIFY_EMAIL_QUEUE,
  NOTIFY_EMERGENCY_QUEUE,
  NOTIFY_SMS_QUEUE,
  PROCESS_CALL_QUEUE,
  startQueue,
} from "./jobs/queue.ts";
import { FakeAuthProvider } from "./providers/auth.fake.ts";
import { FakeEmailProvider } from "./providers/email.fake.ts";
import type { LlmProvider, LlmRequest, LlmResult } from "./providers/llm.ts";
import { FakePaymentsProvider } from "./providers/payments.fake.ts";
import { FakeSmsProvider } from "./providers/sms.fake.ts";
import type { SmsMessage, SmsReceipt } from "./providers/sms.ts";
import { FakeTelephonyProvider } from "./providers/telephony.fake.ts";
import { FakeVoiceProvider } from "./providers/voice.fake.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "./testing/databases.ts";
import { STAND_IN_ENV } from "./testing/stand-in-env.ts";
import { WORK_OPTIONS, registerJobs } from "./worker-jobs.ts";

// Fictional data only (CLAUDE.md): numbers from Ofcom's drama ranges.
const MOBILE = "+447700900001";
const CALLER = "+447700900123";
const EMAIL = "owner@example.com";

/** Eight calls, two of them gas emergencies (the agent spoke the gas script). */
const CALLS = 8;
const isGas = (i: number) => i % 4 === 3;
/** As the real model takes seconds: long enough that one at a time would plainly show. */
const LLM_WAIT_MS = 2_000;
const SMS_WAIT_MS = 200;

/**
 * Other test files share these queues and run alongside this one, so this file's jobs carry a
 * priority no one else's do (they all have the default, 0), and its workers take only those.
 * Without that its workers would run other files' jobs, and theirs this file's.
 */
const OWN = 7351;

/** The worker's pools at the worker's sizes: the app pool at APP_POOL_MAX, pg-boss's at QUEUE_POOL_MAX. */
const app = createPool(TEST_DATABASE_URL);
let boss: PgBoss;
/** For setting up and reading back, so none of that takes a connection from the jobs. */
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);
const observer = createPool(TEST_DATABASE_URL, { max: 1 });

beforeAll(async () => {
  boss = await startQueue(TEST_DATABASE_URL);
});

afterAll(async () => {
  await boss.stop({ graceful: false, close: true });
  await Promise.all([app.end(), admin.end(), observer.end()]);
});

/**
 * pg-boss as registerJobs sees it, but every job sent carries OWN and every worker takes only
 * those. Records the options each queue's worker was given. Recurring jobs aren't scheduled:
 * none is wanted here, and a schedule would outlive the test.
 */
function ownJobsOnly(real: PgBoss, given: Map<string, WorkOptions>): PgBoss {
  const work = (name: string, ...rest: unknown[]) => {
    const options = (rest.length > 1 ? rest[0] : {}) as WorkOptions;
    given.set(name, options);
    return real.work(name, { ...options, minPriority: OWN }, rest.at(-1) as WorkHandler<unknown>);
  };
  const send = (name: string, data: object, options: SendOptions = {}) =>
    real.send(name, data, { ...options, priority: OWN });
  const schedule = () => Promise.resolve();
  return new Proxy(real, {
    get(target, property) {
      if (property === "work") return work;
      if (property === "send") return send;
      if (property === "schedule") return schedule;
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/** Answers each extraction after LLM_WAIT_MS, noting which call it was and how many at once. */
class SlowLlm implements LlmProvider {
  readonly model = "fake-model";
  readonly asked: string[] = [];
  inFlight = 0;
  mostAtOnce = 0;
  firstStartedAt = Infinity;
  lastEndedAt = 0;

  async extract<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
    const ref = /reference (R\d+)/.exec(request.user)?.[1] ?? "none";
    this.asked.push(ref);
    this.inFlight++;
    this.mostAtOnce = Math.max(this.mostAtOnce, this.inFlight);
    this.firstStartedAt = Math.min(this.firstStartedAt, Date.now());
    try {
      await sleep(LLM_WAIT_MS);
    } finally {
      this.inFlight--;
      this.lastEndedAt = Date.now();
    }
    const value = request.schema.parse({
      callerName: "Sam",
      callbackNumber: CALLER,
      postcode: "XQ12 3JL",
      jobSummary: `Boiler leaking, reference ${ref}.`,
      urgency: "routine",
      priceAsked: false,
      flags: [],
    });
    return { ok: true, value, usage: { inputTokens: 100, outputTokens: 20 } };
  }
}

/** The fake SMS provider, taking SMS_WAIT_MS a text and noting how many it sends at once. */
class SlowSms extends FakeSmsProvider {
  inFlight = 0;
  mostAtOnce = 0;

  override async send(message: SmsMessage): Promise<SmsReceipt> {
    this.inFlight++;
    this.mostAtOnce = Math.max(this.mostAtOnce, this.inFlight);
    try {
      await sleep(SMS_WAIT_MS);
      return await super.send(message);
    } finally {
      this.inFlight--;
    }
  }
}

interface Call {
  ref: string;
  gas: boolean;
  tenantId: string;
  callId: string;
  providerCallId: string;
}

/** Four businesses with two calls each, so calls of the same business run side by side too. */
async function makeCalls(): Promise<Call[]> {
  const tenants: string[] = [];
  for (let t = 0; t < CALLS / 2; t++) {
    tenants.push(
      await createTenant(admin, {
        businessName: "Parallel Plumbing",
        contactName: "Ant",
        trade: "plumber",
        notificationMobile: MOBILE,
        notificationEmail: EMAIL,
      }),
    );
  }
  const calls: Call[] = [];
  for (let i = 0; i < CALLS; i++) {
    const ref = `R${i}`;
    const gas = isGas(i);
    const tenantId = tenants[i % tenants.length]!;
    const providerCallId = `call_${randomUUID()}`;
    const transcript = [
      "agent: Hi, you're through to Parallel Plumbing. How can I help?",
      `caller: My boiler's leaking, reference ${ref}.`,
      ...(gas ? ["caller: And I can smell gas.", `agent: ${gasScript("Ant", "GB")}`] : []),
    ].join("\n");
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO calls (tenant_id, provider_call_id, caller_number, started_at, ended_at, transcript)
       VALUES ($1, $2, $3, now() - interval '2 minutes', now(), $4) RETURNING id`,
      [tenantId, providerCallId, CALLER, transcript],
    );
    calls.push({ ref, gas, tenantId, callId: rows[0]!.id, providerCallId });
  }
  return calls;
}

async function until(check: () => Promise<boolean>, what: string, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(100);
  }
}

describe("the worker's jobs, many at once", () => {
  it(
    "processes calls side by side, each once, and sends each message once however often it's queued",
    { timeout: 90_000 },
    async () => {
      const calls = await makeCalls();
      const given = new Map<string, WorkOptions>();
      const queue = ownJobsOnly(boss, given);
      const llm = new SlowLlm();
      const sms = new SlowSms();
      const email = new FakeEmailProvider();
      const env = { ...STAND_IN_ENV, OUTBOUND_ALLOWLIST: `${MOBILE},${CALLER},${EMAIL}` };
      const config = loadConfig(env);

      // As recordCallEnded queues it: keyed by the provider's call ID.
      const queueProcessing = (call: Call) =>
        queue.send(
          PROCESS_CALL_QUEUE,
          { tenantId: call.tenantId, callId: call.callId, providerCallId: call.providerCallId },
          { singletonKey: call.providerCallId },
        );
      const queueMessages = (call: Call) => [
        queue.send(
          NOTIFY_SMS_QUEUE,
          { tenantId: call.tenantId, callId: call.callId },
          { singletonKey: call.callId },
        ),
        queue.send(
          NOTIFY_EMAIL_QUEUE,
          { tenantId: call.tenantId, callId: call.callId },
          { singletonKey: call.callId },
        ),
        ...(call.gas
          ? [
              queue.send(
                NOTIFY_EMERGENCY_QUEUE,
                { tenantId: call.tenantId, callId: call.callId },
                { singletonKey: call.callId },
              ),
            ]
          : []),
      ];
      const ownJobs = async () =>
        (
          await observer.query<{ name: string; state: string; retry_count: number }>(
            "SELECT name, state, retry_count FROM pgboss.job WHERE priority = $1",
            [OWN],
          )
        ).rows;
      const allSettled = async () =>
        (await ownJobs()).every((job) => job.state === "completed" || job.state === "failed");
      const messages = async () =>
        (
          await admin.query<{
            call_id: string;
            channel: string;
            status: string;
            provider_ref: string | null;
          }>(
            "SELECT call_id, channel, status, provider_ref FROM notifications WHERE call_id = ANY($1)",
            [calls.map((call) => call.callId)],
          )
        ).rows;
      // A text and an email each; a gas emergency adds the priority text and the caller's text.
      const expectedMessages = calls.reduce((n, call) => n + (call.gas ? 4 : 2), 0);

      // Every call delivered three times at once, as a retried webhook and reconciliation can:
      // the queue keeps one job a call.
      const firstIds = await Promise.all(
        calls.flatMap((call) => [1, 2, 3].map(() => queueProcessing(call))),
      );
      expect(firstIds.filter((id) => id !== null)).toHaveLength(CALLS);

      const queues = await registerJobs(
        { ...config, retellApiKey: config.retellApiKey ?? "" },
        {
          boss: queue,
          pool: app,
          admin: null,
          providers: {
            voice: new FakeVoiceProvider(),
            llm,
            sms,
            email,
            telephony: new FakeTelephonyProvider(),
            auth: new FakeAuthProvider(),
            payments: new FakePaymentsProvider(),
          },
        },
      );
      expect(queues).toEqual(expect.arrayContaining(Object.keys(WORK_OPTIONS)));
      for (const [name, options] of Object.entries(WORK_OPTIONS)) {
        expect(given.get(name), name).toEqual(options);
      }

      // And again while the first are running or waiting: still nothing added.
      await until(() => Promise.resolve(llm.inFlight > 0), "the first extraction");
      expect(await Promise.all(calls.map(queueProcessing))).toEqual(calls.map(() => null));

      await until(
        async () =>
          (await messages()).filter((m) => m.status === "sent").length === expectedMessages,
        "every message",
      );
      await until(allSettled, "the first jobs to finish");

      // Delivered once more after they're done (a job retried after a crash, a late
      // reconciliation): new jobs this time, which find the call processed and the messages sent.
      const lateIds = await Promise.all(
        calls.flatMap((call) => [queueProcessing(call), ...queueMessages(call)]),
      );
      expect(lateIds.every((id) => id !== null)).toBe(true);
      await until(allSettled, "the late jobs to finish");

      // Each call went to the LLM once, four at a time (process-call's concurrency), in well
      // under the time one at a time would take.
      expect([...llm.asked].sort()).toEqual(calls.map((call) => call.ref).sort());
      expect(llm.mostAtOnce).toBe(WORK_OPTIONS[PROCESS_CALL_QUEUE].localConcurrency);
      expect(llm.lastEndedAt - llm.firstStartedAt).toBeLessThan((CALLS * LLM_WAIT_MS) / 2);
      expect(sms.mostAtOnce).toBeGreaterThan(1);

      // Each message once: its row says sent, and the provider was asked exactly once for it.
      const rows = await messages();
      for (const call of calls) {
        const channels = rows
          .filter((m) => m.call_id === call.callId)
          .map((m) => `${m.channel}:${m.status}`)
          .sort();
        expect(channels, call.ref).toEqual(
          call.gas
            ? ["email:sent", "sms:sent", "sms_caller:sent", "sms_emergency:sent"]
            : ["email:sent", "sms:sent"],
        );
      }
      const refsOf = (channels: string[]) =>
        rows
          .filter((m) => channels.includes(m.channel))
          .map((m) => m.provider_ref)
          .sort();
      expect(sms.sent.map((text) => text.providerRef).sort()).toEqual(
        refsOf(["sms", "sms_emergency", "sms_caller"]),
      );
      expect(email.sent.map((message) => message.providerRef).sort()).toEqual(refsOf(["email"]));
      // And each summary text links to its own call.
      const linked = sms.sent.flatMap((text) => {
        const link = /Details: (\S+)$/m.exec(text.body)?.[1];
        const check = link ? verifyCallLink(link.split("/c/")[1]!, config.signingSecret!) : null;
        return check?.ok ? [check.callId] : [];
      });
      expect(linked.sort()).toEqual(calls.map((call) => call.callId).sort());

      // No job failed, so none waited out a connection: every one finished on its first go.
      const jobs = await ownJobs();
      expect(jobs.filter((job) => job.state !== "completed" || job.retry_count !== 0)).toEqual([]);
    },
  );
});
