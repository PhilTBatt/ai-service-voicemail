// Makes an account claimable again by its email (db/cross-tenant.ts resetLogin): the next
// sign-in with that verified address takes it, as a first sign-in would. For when the login
// provider changes (Clerk's production instance, RUNBOOK section 16) or someone has lost
// their old login. Touches only our database. Run from the repo root, or as a task:
//   npm run reset-login -- --email phil@example.com
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadConfig } from "../config.ts";
import { auditScriptAction, createAdminPool, resetLogin } from "../db/cross-tenant.ts";

const { values } = parseArgs({ options: { email: { type: "string" } } });
const args = z.object({ email: z.email() }).safeParse(values);
if (!args.success) {
  console.error("Usage: npm run reset-login -- --email <address>");
  process.exit(2);
}

const config = loadConfig(process.env);
if (!config.adminDatabaseUrl) {
  console.error("ADMIN_DATABASE_URL is missing");
  process.exit(1);
}
const admin = createAdminPool(config.adminDatabaseUrl);
try {
  const reset = await resetLogin(admin, args.data.email);
  if (reset) {
    await auditScriptAction(admin, { tenantId: null, action: "user.login-reset", details: {} });
    console.log("Login reset: the next sign-in with that email claims the account.");
  } else {
    console.log("Nothing to reset: no claimed account has that email.");
    process.exitCode = 1;
  }
} finally {
  await admin.end();
}
