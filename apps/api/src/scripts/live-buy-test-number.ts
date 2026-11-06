// Buys the one Step 4 test number for the seeded demo tenant. COSTS MONEY (a few pounds a
// month). Named live-* as CLAUDE.md requires; .claude/settings.json makes Claude Code ask
// before running anything called npm run live-*.
//
//   npm run live-buy-test-number -- --search 0113          list numbers containing 0113
//   npm run live-buy-test-number -- --buy +441134960100    show what would happen
//   npm run live-buy-test-number -- --buy +441134960100 --confirm   actually buy it
//
// Needs in .env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PURCHASES_ENABLED=true,
// TWILIO_BUNDLE_SID, TWILIO_ADDRESS_SID, PUBLIC_BASE_URL, FALLBACK_VOICEMAIL_URL and
// ADMIN_DATABASE_URL.
import { parseArgs } from "node:util";
import { buyNumberForTenant, searchNumbers } from "../admin/test-number.ts";
import { loadConfig } from "../config.ts";
import { createAdminPool } from "../db/cross-tenant.ts";
import { SEED_TENANTS } from "../db/seed.ts";
import { TwilioTelephonyProvider } from "../providers/twilio.ts";

const { values } = parseArgs({
  options: {
    search: { type: "string" },
    buy: { type: "string" },
    confirm: { type: "boolean", default: false },
  },
});

const config = loadConfig(process.env);
const missing = [
  !config.twilio && "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN",
  !config.publicBaseUrl && "PUBLIC_BASE_URL",
  !config.fallbackVoicemailUrl && "FALLBACK_VOICEMAIL_URL",
  !process.env.ADMIN_DATABASE_URL && "ADMIN_DATABASE_URL",
].filter((name): name is string => typeof name === "string");
if (missing.length > 0 || !config.twilio || !config.publicBaseUrl || !config.fallbackVoicemailUrl) {
  console.error(`Missing in .env: ${missing.join(", ")}`);
  process.exit(1);
}

const telephony = new TwilioTelephonyProvider(config.twilio);

if (values.search !== undefined) {
  const found = await searchNumbers(telephony, values.search);
  console.log(found.length === 0 ? "No numbers found." : "Available (E.164 | locality):");
  for (const n of found) console.log(`  ${n.number} | ${n.locality ?? "-"}, ${n.region ?? "-"}`);
} else if (values.buy !== undefined) {
  const demo = SEED_TENANTS[0]!;
  if (!config.twilio.bundleSid || !config.twilio.addressSid) {
    console.error("TWILIO_BUNDLE_SID and TWILIO_ADDRESS_SID are needed to buy a UK number.");
    process.exit(1);
  }
  if (!config.twilio.purchasesEnabled) {
    console.error("TWILIO_PURCHASES_ENABLED is not true. Set it in .env for this run only.");
    process.exit(1);
  }
  console.log(`Would buy ${values.buy} for "${demo.businessName}" (${demo.id}):`);
  console.log(`  voice URL:    ${config.publicBaseUrl}/webhooks/twilio/voice`);
  console.log(`  fallback URL: ${config.fallbackVoicemailUrl}`);
  if (!values.confirm) {
    console.log("Dry run. Add --confirm to buy it.");
  } else {
    const admin = createAdminPool(process.env.ADMIN_DATABASE_URL!);
    try {
      const bought = await buyNumberForTenant(
        {
          telephony,
          admin,
          publicBaseUrl: config.publicBaseUrl,
          fallbackVoicemailUrl: config.fallbackVoicemailUrl,
        },
        { tenantId: demo.id, number: values.buy, confirm: true },
      );
      console.log(
        `Bought ${bought.number} (${bought.providerSid}) and assigned it to the demo tenant.`,
      );
      console.log("Now set TWILIO_PURCHASES_ENABLED back to false in .env.");
    } finally {
      await admin.end();
    }
  }
} else {
  console.error("Use --search <digits>, or --buy <+44 number> [--confirm].");
  process.exit(1);
}
