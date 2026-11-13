// The API for the browser smoke tests (npm run e2e). The real app, routes, roles and database
// code, against the test database, with stand-ins only for the outside world: the login
// provider (E2eAuthProvider instead of Clerk) and the voice and telephony providers. Playwright
// starts it (apps/web/playwright.config.ts) and stops it afterwards.
//
// Fictional data only (CLAUDE.md): Ofcom drama-range numbers, example.com addresses.
import { createServer } from "node:http";
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
import type { NumberConfiguration, PurchasedNumber } from "../providers/telephony.ts";
import { parseAllowlist } from "../core/outbound-allowlist.ts";
import { FakeSmsProvider } from "../providers/sms.fake.ts";
import { FakeTelephonyProvider } from "../providers/telephony.fake.ts";
import { FakeVoiceProvider } from "../providers/voice.fake.ts";
import type { NumberProvisioning } from "../routes/admin.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "./databases.ts";
import { E2eAuthProvider } from "./e2e-auth.ts";
import prepareTestDatabase from "./global-setup.ts";

export const E2E_API_PORT = 3100;

/**
 * The request header that picks how this server buys numbers (apps/web/e2e/support.ts names it
 * too). Without it, it can't, as a server without Twilio's settings can't: journeys.e2e.ts
 * checks the page says so. "on" buys from a stand-in for Twilio, with purchases allowed and the
 * UK bundle and address in place; "switched-off" is the same with TWILIO_PURCHASES_ENABLED off.
 * A header rather than a second server because the routes take their numbers setup once, when
 * they're built, and the dashboard reaches this server through one address (vite.config.ts).
 */
const NUMBERS_HEADER = "x-e2e-numbers";

/**
 * The fake Twilio, stocked for the admin's number card: its own five Leeds numbers (0113 496 0100
 * to 0104) and three from 01632 960, Ofcom's drama ranges both, so a search by area code has
 * something to leave out. As Twilio does, it stops offering a number once it's bought, so a test
 * retried on the same server finds another rather than one the database already holds.
 */
class E2eNumberShop extends FakeTelephonyProvider {
  constructor(options: { purchasesEnabled: boolean }) {
    super(options);
    this.available.push(
      ...["+441632960100", "+441632960101", "+441632960102"].map((number) => ({
        number,
        locality: null,
        region: null,
      })),
    );
  }

  override async purchaseNumber(
    number: string,
    config: NumberConfiguration,
    options: { live: boolean },
  ): Promise<PurchasedNumber> {
    const bought = await super.purchaseNumber(number, config, options);
    const sold = this.available.findIndex((offer) => offer.number === bought.number);
    if (sold !== -1) this.available.splice(sold, 1);
    return bought;
  }
}

/** Buying numbers as server-app.ts wires it, but from the stand-in, never from Twilio. */
function numbersSetup(purchasesEnabled: boolean): NumberProvisioning {
  return {
    telephony: new E2eNumberShop({ purchasesEnabled }),
    publicBaseUrl: `http://localhost:${E2E_API_PORT}`,
    fallbackVoicemailUrl: "https://example.com/e2e-fallback-voicemail",
    purchasesEnabled,
    ukRegulatoryReady: true,
  };
}

/** Who and what the smoke tests expect to find. */
async function seed(admin: AdminPool): Promise<void> {
  const plumbing = await createTenant(admin, {
    businessName: "Fern Lane Plumbing",
    trade: "plumber",
    contactName: "Sam",
    notificationMobile: "+447700900123",
  });
  await admin.query("UPDATE tenants SET status = 'live', mobile_network = 'o2' WHERE id = $1", [
    plumbing,
  ]);
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
  // Flagged as if the agent had named a price, so the admin's review queue has a call in it,
  // with a note from the summary too: the call page shows the note and not the review flag.
  await admin.query(
    `INSERT INTO calls (tenant_id, provider_call_id, started_at, ended_at, summary, urgency, flags)
     VALUES ($1, 'call_e2e_2', now() - interval '2 hours', now() - interval '119 minutes',
             'Fuse box tripping.', 'routine', '{guardrail:price,"mentioned burning smell"}')`,
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

// One app for each numbers setup, sharing everything else: the database, the queue, and the
// sign-in stand-in (which remembers who signed in, so it must be the one object).
const dashboard = {
  admin,
  auth: new E2eAuthProvider(),
  boss,
  voice: new FakeVoiceProvider(),
  telephony: new FakeTelephonyProvider(),
  // Confirming a new notification mobile: the code goes to a fake, so the browser tests know it
  // (the drama-range mobiles the tests use are on the allowlist; any other is blocked, as outside
  // production).
  sms: {
    provider: new FakeSmsProvider(),
    outbound: {
      nodeEnv: "test" as const,
      allowlist: parseAllowlist("+447700900123,+447700900124"),
    },
  },
  newMobileCode: () => "123456",
};
const withoutNumbers = createApp({ pool, dashboard });
const withNumbers = createApp({ pool, dashboard: { ...dashboard, numbers: numbersSetup(true) } });
const purchasesOff = createApp({
  pool,
  dashboard: { ...dashboard, numbers: numbersSetup(false) },
});
createServer((req, res) => {
  const asked = req.headers[NUMBERS_HEADER];
  const app =
    asked === "on" ? withNumbers : asked === "switched-off" ? purchasesOff : withoutNumbers;
  app(req, res);
}).listen(E2E_API_PORT, () => {
  logger.info("Smoke-test API listening", { port: E2E_API_PORT });
});
