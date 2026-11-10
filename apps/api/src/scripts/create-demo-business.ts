// Sets up the demo business on this database (db/demo-business.ts): the tenant with the
// seed's fixed ID, its number, and its agent profile with the sync queued for the worker.
// Run against production as a task (RUNBOOK section 16) with the contact details in the
// environment (Key Vault: demo-mobile, demo-email), never on the command line, where a
// public repository's Actions log would show them:
//   node apps/api/src/scripts/create-demo-business.ts --number +44... --sid PN...
// Touches only our database; pointing the number at the API is live-configure-number's job.
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadConfig } from "../config.ts";
import { ukMobileFromInput } from "../core/phone.ts";
import { createAdminPool } from "../db/cross-tenant.ts";
import { createDemoBusiness } from "../db/demo-business.ts";
import { createPool } from "../db/pool.ts";
import { startQueue } from "../jobs/queue.ts";

const { values } = parseArgs({
  options: { number: { type: "string" }, sid: { type: "string" } },
});

/**
 * Says what shape a value has without saying what it is: enough to tell "the new version
 * hasn't reached the job yet" from "typed wrong", with no number in the log.
 */
function shapeOf(value: string | undefined): string {
  if (value === undefined) return "not set";
  const kinds = [
    /^\+/.test(value) ? "starts with +" : "no +",
    /\s/.test(value) ? "has spaces" : "no spaces",
    `${value.replace(/\D/g, "").length} digits`,
  ];
  return `${value.length} characters: ${kinds.join(", ")}`;
}

const input = z
  .object({
    number: z.string().regex(/^\+44\d{9,10}$/, "a UK number in E.164 form, like +441134960100"),
    sid: z.string().regex(/^PN[0-9a-f]{32}$/, "the number's Twilio SID: PN and 32 hex characters"),
    email: z.email("DEMO_EMAIL must be an email address"),
  })
  .safeParse({ ...values, email: process.env.DEMO_EMAIL });
const mobile = ukMobileFromInput(process.env.DEMO_MOBILE);
if (!input.success || mobile === null) {
  console.error(
    "Usage: create-demo-business.ts --number <E.164> --sid <PN...>, with DEMO_MOBILE and DEMO_EMAIL set",
  );
  if (!input.success) {
    for (const issue of input.error.issues)
      console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  if (mobile === null) {
    console.error(
      `  DEMO_MOBILE: must be a UK mobile (07700 900123 or +447700900123); what's set is ${shapeOf(process.env.DEMO_MOBILE)}`,
    );
  }
  process.exit(2);
}

const config = loadConfig(process.env);
if (!config.adminDatabaseUrl) {
  console.error("ADMIN_DATABASE_URL is missing");
  process.exit(1);
}
const admin = createAdminPool(config.adminDatabaseUrl);
const pool = createPool(config.databaseUrl);
const boss = await startQueue(config.databaseUrl);
try {
  const outcome = await createDemoBusiness(
    { admin, pool, boss },
    {
      mobile,
      email: input.data.email,
      number: input.data.number,
      providerSid: input.data.sid,
    },
  );
  console.log(
    [
      `Demo business ${outcome.created ? "created" : "already there"} (${outcome.tenantId}).`,
      `Number ${outcome.numberRecorded ? "recorded" : "already recorded"}.`,
      `Profile saved as version ${outcome.profileVersion}; the worker syncs it to Retell.`,
    ].join(" "),
  );
} finally {
  await boss.stop({ graceful: true, close: true });
  await Promise.all([pool.end(), admin.end()]);
}
