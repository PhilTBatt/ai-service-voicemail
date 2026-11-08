// The API for the load tests (npm run load, BUILD_PLAN Step 14). The real app, routes and
// database code against the test database, with fakes for every outside service, so k6 can hit
// the webhooks and the dashboard as hard as it likes without reaching Twilio, the voice
// platform or Clerk. The fakes check webhook signatures with fixed test keys, and the k6 script
// (apps/api/load/k6-load-test.js) signs with the same keys.
//
// It seeds LOAD_CUSTOMERS live businesses (100 by default), each with a number, a synced agent,
// an owner and 20 past calls. Fictional data only (CLAUDE.md): Ofcom's drama ranges, so 1,000
// businesses at most. Like npm test and npm run e2e, it empties the test database first.
import { createApp } from "../app.ts";
import { parseAllowlist } from "../core/outbound-allowlist.ts";
import { recordCallEnded, recordMidCallEmergency } from "../db/calls.ts";
import {
  addMembership,
  assignPhoneNumber,
  createAdminPool,
  createTenant,
  inviteUser,
  type AdminPool,
} from "../db/cross-tenant.ts";
import { createPool } from "../db/pool.ts";
import { enqueueNotificationsWith } from "../jobs/enqueue-notifications.ts";
import { enqueueOnboardingWith } from "../jobs/onboarding.ts";
import { startQueue } from "../jobs/queue.ts";
import { enqueueSyncAgent } from "../jobs/sync-agent.ts";
import { logger } from "../logger.ts";
import { FakeTelephonyProvider } from "../providers/telephony.fake.ts";
import { FakeVoiceProvider } from "../providers/voice.fake.ts";
import { sampleAgentDefinition } from "./agent-fixture.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "./databases.ts";
import { E2eAuthProvider } from "./e2e-auth.ts";
import prepareTestDatabase from "./global-setup.ts";
import { LOAD_API_PORT, LOAD_PUBLIC_BASE_URL } from "./load-config.ts";

const customers = Number(process.env.LOAD_CUSTOMERS ?? "100");
if (!Number.isInteger(customers) || customers < 1 || customers > 1000) {
  throw new Error("LOAD_CUSTOMERS must be a whole number from 1 to 1000");
}
// The runner turns this down to "warn": a line per request would drown the k6 report.
logger.level = process.env.LOG_LEVEL ?? "info";

/** Business i's numbers, as the k6 script works them out too. */
const pad = (i: number) => String(i).padStart(3, "0");

async function seed(admin: AdminPool, voice: FakeVoiceProvider): Promise<void> {
  for (let i = 0; i < customers; i++) {
    const tenantId = await createTenant(admin, {
      businessName: `Load Test Plumbing ${pad(i)}`,
      trade: "plumber",
      contactName: "Sam",
      notificationMobile: `+447700900${pad(i)}`,
    });
    await admin.query(
      "UPDATE tenants SET status = 'live', onboarding_state = 'live' WHERE id = $1",
      [tenantId],
    );
    await assignPhoneNumber(admin, tenantId, `+441632960${pad(i)}`, `PNload${pad(i)}`);
    const agentId = `agent_load_${pad(i)}`;
    await admin.query(
      `INSERT INTO agent_profiles (tenant_id, version, trade_template, provider_agent_id, synced_at)
       VALUES ($1, 1, 'plumber', $2, now())`,
      [tenantId, agentId],
    );
    voice.agents.set(agentId, sampleAgentDefinition());
    // History for the dashboard to show: 20 calls over the last three weeks.
    await admin.query(
      `INSERT INTO calls (tenant_id, provider_call_id, caller_number, started_at, ended_at,
                          billable_seconds, transcript, summary, urgency, extracted_fields)
       SELECT $1, 'call_load_' || $2 || '_' || n, '+447700900999',
              now() - n * interval '1 day 3 hours',
              now() - n * interval '1 day 3 hours' + interval '2 minutes', 120,
              E'agent: Hello, you''re through to Load Test Plumbing.\\ncaller: My tap is dripping.',
              'Tap dripping in the kitchen.', 'routine',
              '{"callerName":"Robin Ash","callbackNumber":"+447700900999","postcode":"XQ1 2AB"}'
       FROM generate_series(1, 20) AS n`,
      [tenantId, pad(i)],
    );
    const owner = await inviteUser(admin, { email: `owner${pad(i)}@example.com`, role: "owner" });
    if (owner.outcome !== "invited") throw new Error(`Couldn't invite load-test owner ${i}`);
    await addMembership(admin, tenantId, owner.userId);
  }
}

await prepareTestDatabase(); // migrate, then empty
const pool = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);
const voice = new FakeVoiceProvider();
const telephony = new FakeTelephonyProvider();
await seed(admin, voice);
const boss = await startQueue(TEST_DATABASE_URL);

const app = createApp({
  pool,
  voiceProviders: { fake: voice },
  onCallEnded: async (event) => {
    await recordCallEnded(pool, boss, event);
  },
  onFunctionCall: (event) => recordMidCallEmergency(pool, boss, event),
  telephony: {
    provider: telephony,
    voice,
    publicBaseUrl: LOAD_PUBLIC_BASE_URL,
    // Nothing goes out: no address is allowed, and every provider is a fake anyway.
    outbound: { nodeEnv: "test", allowlist: parseAllowlist("") },
    enqueueSync: (job) => enqueueSyncAgent(boss, job),
    enqueueNotifications: enqueueNotificationsWith(boss),
    enqueueOnboarding: enqueueOnboardingWith(boss),
  },
  dashboard: { admin, auth: new E2eAuthProvider(), boss, voice, telephony },
});
app.listen(LOAD_API_PORT, () => {
  logger.info("Load-test API listening", { port: LOAD_API_PORT, customers });
});
