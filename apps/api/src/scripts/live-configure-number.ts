// Points the demo tenant's number at the current PUBLIC_BASE_URL and FALLBACK_VOICEMAIL_URL,
// for when the tunnel domain or the voicemail bin changes, or adopts a number bought in the
// Twilio console so our records know it. Changes settings at Twilio (no charge), so it's
// named live-* and asks for --confirm. Run from the repo root:
//   npm run live-configure-number                         show the current and intended settings
//   npm run live-configure-number -- --confirm            apply them to the demo tenant's number
//   npm run live-configure-number -- --adopt +44... --sid PN... --confirm
//                                                         record a console-bought number, then apply
import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import {
  activeNumberFor,
  auditScriptAction,
  createAdminPool,
  reassignNumber,
} from "../db/cross-tenant.ts";
import { SEED_TENANTS } from "../db/seed.ts";
import { TwilioTelephonyProvider } from "../providers/twilio.ts";

const { values } = parseArgs({
  options: {
    confirm: { type: "boolean", default: false },
    adopt: { type: "string" },
    sid: { type: "string" },
  },
});

const config = loadConfig(process.env);
if (!config.twilio || !config.publicBaseUrl || !config.fallbackVoicemailUrl) {
  console.error(
    "Needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, PUBLIC_BASE_URL and FALLBACK_VOICEMAIL_URL in .env.",
  );
  process.exit(1);
}
if (!config.adminDatabaseUrl) {
  console.error("Needs ADMIN_DATABASE_URL in .env to find the demo tenant's number.");
  process.exit(1);
}
if ((values.adopt === undefined) !== (values.sid === undefined)) {
  console.error("--adopt <E.164 number> and --sid <PN...> go together.");
  process.exit(1);
}
if (values.adopt !== undefined && !/^\+44\d{9,10}$/.test(values.adopt)) {
  console.error("--adopt must be a UK number in E.164 form, like +441134960100.");
  process.exit(1);
}
if (values.sid !== undefined && !/^PN[0-9a-f]{32}$/.test(values.sid)) {
  console.error("--sid must be the number's Twilio SID: PN followed by 32 hex characters.");
  process.exit(1);
}

const demo = SEED_TENANTS[0]!;
const admin = createAdminPool(config.adminDatabaseUrl);
try {
  let active = await activeNumberFor(admin, demo.id);
  if (values.adopt !== undefined && values.sid !== undefined) {
    console.log(`Would record ${values.adopt} (${values.sid}) as "${demo.businessName}"'s number.`);
    if (values.confirm) {
      await reassignNumber(admin, demo.id, values.adopt, values.sid);
      await auditScriptAction(admin, {
        tenantId: demo.id,
        action: "number.adopted",
        details: { number: values.adopt, providerSid: values.sid },
      });
      active = { number: values.adopt, providerSid: values.sid };
      console.log("Recorded.");
    }
  }
  if (!active) {
    console.error(
      `"${demo.businessName}" has no active number yet (npm run live-buy-test-number, or --adopt).`,
    );
    process.exit(1);
  }
  const settings = {
    voiceUrl: `${config.publicBaseUrl}/webhooks/twilio/voice`,
    voiceFallbackUrl: config.fallbackVoicemailUrl,
    smsUrl: `${config.publicBaseUrl}/webhooks/twilio/sms`,
    friendlyName: `CallMate ${demo.id}`,
  };
  console.log(`${active.number} (${active.providerSid}) will be set to:`);
  console.log(`  voice URL:    ${settings.voiceUrl}`);
  console.log(`  fallback URL: ${settings.voiceFallbackUrl}`);
  console.log(`  SMS URL:      ${settings.smsUrl}`);
  if (!values.confirm) {
    console.log("Dry run. Add --confirm to apply.");
  } else {
    await new TwilioTelephonyProvider(config.twilio).configureNumber(active.providerSid, settings);
    console.log("Applied.");
  }
} finally {
  await admin.end();
}
