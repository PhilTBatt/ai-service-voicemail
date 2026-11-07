// The API for the browser smoke tests (npm run e2e). The real app, routes, roles and database
// code, against the test database, with stand-ins only for the outside world: the login
// provider (E2eAuthProvider instead of Clerk) and the voice and telephony providers. Playwright
// starts it (apps/web/playwright.config.ts) and stops it afterwards.
//
// Fictional data only (CLAUDE.md): Ofcom drama-range numbers, example.com addresses.
import { createApp } from "../app.ts";
import {
  assignPhoneNumber,
  createAdminPool,
  createTenant,
  inviteUser,
  addMembership,
  type AdminPool,
} from "../db/cross-tenant.ts";
import { createPool } from "../db/pool.ts";
import { startQueue } from "../jobs/queue.ts";
import { logger } from "../logger.ts";
import { FakeTelephonyProvider } from "../providers/telephony.fake.ts";
import { FakeVoiceProvider } from "../providers/voice.fake.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "./databases.ts";
import { E2eAuthProvider } from "./e2e-auth.ts";
import prepareTestDatabase from "./global-setup.ts";

export const E2E_API_PORT = 3100;

/** Who and what the smoke tests expect to find. */
async function seed(admin: AdminPool): Promise<void> {
  const plumbing = await createTenant(admin, {
    businessName: "Fern Lane Plumbing",
    trade: "plumber",
    contactName: "Sam",
    notificationMobile: "+447700900123",
  });
  await admin.query("UPDATE tenants SET status = 'live' WHERE id = $1", [plumbing]);
  await assignPhoneNumber(admin, plumbing, "+441134960150", "PNe2eFernLane");
  await admin.query(
    `INSERT INTO calls (tenant_id, provider_call_id, caller_number, started_at, ended_at,
                        billable_seconds, transcript, summary, urgency, extracted_fields)
     VALUES ($1, 'call_e2e_1', '+447700900456', now() - interval '1 hour',
             now() - interval '58 minutes', 120,
             E'agent: Hello, you''re through to Fern Lane Plumbing.\\ncaller: My boiler is leaking under the stairs.',
             'Boiler leaking under the stairs.', 'urgent',
             '{"callerName":"Robin Ash","callbackNumber":"+447700900456","postcode":"XQ1 2AB"}')`,
    [plumbing],
  );

  const sparks = await createTenant(admin, { businessName: "Other Sparks", trade: "electrician" });
  await admin.query(
    `INSERT INTO calls (tenant_id, provider_call_id, started_at, ended_at, summary, urgency)
     VALUES ($1, 'call_e2e_2', now() - interval '2 hours', now() - interval '119 minutes',
             'Fuse box tripping.', 'routine')`,
    [sparks],
  );

  await inviteUser(admin, { email: "admin@example.com", role: "admin" });
  const owner = await inviteUser(admin, { email: "owner@example.com", role: "owner" });
  if (owner.outcome !== "invited") throw new Error("Couldn't invite the e2e owner");
  await addMembership(admin, plumbing, owner.userId);
}

await prepareTestDatabase(); // migrate, then empty: every smoke-test run starts the same
const pool = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);
await seed(admin);
const boss = await startQueue(TEST_DATABASE_URL);

const app = createApp({
  pool,
  dashboard: {
    admin,
    auth: new E2eAuthProvider(),
    boss,
    voice: new FakeVoiceProvider(),
    telephony: new FakeTelephonyProvider(),
  },
});
app.listen(E2E_API_PORT, () => {
  logger.info("Smoke-test API listening", { port: E2E_API_PORT });
});
