// The worker for the load tests (npm run load, decision 013): the real job handlers
// (worker-jobs.ts), at the concurrency production gives them (WORK_OPTIONS) and the pool sizes it
// runs with (db/pool.ts), against the test database the load-test API fills. Every outside
// service is a fake that takes about as long as the real one, so the time from a call ending to
// its text is close to what a busy hour would see. Its own process, as in production: the API's
// response times aren't shared with the jobs'.
//
// Started by the runner (scripts/run-load-test.ts) once the API has seeded the businesses.
import { setTimeout as sleep } from "node:timers/promises";
import type { PgBoss } from "pg-boss";
import { loadConfig } from "../config.ts";
import { createAdminPool } from "../db/cross-tenant.ts";
import { WORKER_ADMIN_POOL_MAX, createPool } from "../db/pool.ts";
import { startQueue } from "../jobs/queue.ts";
import { logger } from "../logger.ts";
import { FakeAuthProvider } from "../providers/auth.fake.ts";
import { FakeEmailProvider } from "../providers/email.fake.ts";
import type { EmailMessage } from "../providers/email.ts";
import type { LlmProvider, LlmRequest, LlmResult } from "../providers/llm.ts";
import { FakePaymentsProvider } from "../providers/payments.fake.ts";
import { FakeSmsProvider } from "../providers/sms.fake.ts";
import type { SmsMessage } from "../providers/sms.ts";
import { FakeTelephonyProvider } from "../providers/telephony.fake.ts";
import { FakeVoiceProvider } from "../providers/voice.fake.ts";
import { registerJobs } from "../worker-jobs.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "./databases.ts";
import { LOAD_PUBLIC_BASE_URL, loadCustomers, loadMobile, loadNotifyEmail } from "./load-config.ts";
import { STAND_IN_ENV } from "./stand-in-env.ts";

logger.level = process.env.LOG_LEVEL ?? "info";

/**
 * How long each outside service takes, in milliseconds. The model's is our estimate of a short
 * extraction on the small model (LOAD_LLM_MS overrides it); Twilio and Postmark answer a send in
 * a few hundred milliseconds. None is measured: they're there so the jobs wait as they would.
 */
const LLM_MS = Number(process.env.LOAD_LLM_MS ?? "2000");
const SEND_MS = 300;

/** What the model "says" about every load-test call: a routine dripping tap. */
const EXTRACTION = {
  callerName: "Robin",
  callbackNumber: null,
  postcode: null,
  jobSummary: "Tap dripping in the kitchen.",
  urgency: "routine",
  priceAsked: false,
  flags: [],
};

/** The model, taking as long as the real one, and checked against the request's schema as the real adapter is. */
class SlowLlm implements LlmProvider {
  readonly model = "fake-model";
  async extract<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
    await sleep(LLM_MS);
    const usage = { inputTokens: 400, outputTokens: 80 };
    const parsed = request.schema.safeParse(EXTRACTION);
    return parsed.success
      ? { ok: true, value: parsed.data, usage }
      : { ok: false, reason: "invalid-output", usage };
  }
}

class SlowSms extends FakeSmsProvider {
  override async send(message: SmsMessage) {
    await sleep(SEND_MS);
    return super.send(message);
  }
}

class SlowEmail extends FakeEmailProvider {
  override async send(message: EmailMessage) {
    await sleep(SEND_MS);
    return super.send(message);
  }
}

/**
 * pg-boss as registerJobs sees it, without the recurring jobs: the load is the calls, and a
 * schedule written to the test database would outlive the run and start firing in the next
 * test run's queue.
 */
function withoutSchedules(boss: PgBoss): PgBoss {
  return new Proxy(boss, {
    get(target, property) {
      if (property === "schedule") return () => Promise.resolve();
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

const customers = loadCustomers();
const allowlist = Array.from({ length: customers }, (_, i) => [
  loadMobile(i),
  loadNotifyEmail(i),
]).flat();
const config = loadConfig({
  ...STAND_IN_ENV,
  PUBLIC_BASE_URL: LOAD_PUBLIC_BASE_URL,
  // Outside production only listed addresses get messages: these are the businesses' own.
  OUTBOUND_ALLOWLIST: allowlist.join(","),
  LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
});

const pool = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL, { max: WORKER_ADMIN_POOL_MAX });
const boss = await startQueue(TEST_DATABASE_URL);
const queues = await registerJobs(
  { ...config, retellApiKey: config.retellApiKey ?? "" },
  {
    boss: withoutSchedules(boss),
    pool,
    admin,
    providers: {
      voice: new FakeVoiceProvider(),
      llm: new SlowLlm(),
      sms: new SlowSms(),
      email: new SlowEmail(),
      telephony: new FakeTelephonyProvider(),
      auth: new FakeAuthProvider(),
      payments: new FakePaymentsProvider(),
    },
  },
);
logger.warn("Load-test worker running", { queues: queues.length, llmMs: LLM_MS, sendMs: SEND_MS });

const stop = () => {
  void boss
    .stop({ graceful: false, close: true })
    .then(() => Promise.all([pool.end(), admin.end()]))
    .finally(() => process.exit(0));
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
