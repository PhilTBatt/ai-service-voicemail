// Invites a person to the dashboard (BUILD_PLAN Step 10): creates their account by email and
// role, before they've ever logged in. Their first login with that email claims it. Touches
// only our database, so it isn't a live-* script. Run from the repo root:
//   npm run invite-user -- --email phil@example.com --role admin
//   npm run invite-user -- --email ant@example.com --role reseller
//   npm run invite-user -- --email sam@example.com --role owner --tenant <tenant id>
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadConfig } from "../config.ts";
import { ROLES } from "../db/accounts.ts";
import { addMembership, createAdminPool, inviteUser } from "../db/cross-tenant.ts";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    role: { type: "string" },
    tenant: { type: "string" },
  },
});

const args = z
  .object({
    email: z.email(),
    role: z.enum(ROLES),
    tenant: z.uuid().optional(),
  })
  .refine((a) => (a.role === "owner") === (a.tenant !== undefined), {
    message: "--tenant goes with --role owner, and only with it",
  })
  .safeParse(values);
if (!args.success) {
  console.error(
    "Usage: npm run invite-user -- --email <address> --role owner|admin|reseller [--tenant <id>]",
  );
  for (const issue of args.error.issues)
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  process.exit(1);
}

const config = loadConfig(process.env);
if (!config.adminDatabaseUrl) {
  console.error("Needs ADMIN_DATABASE_URL in .env.");
  process.exit(1);
}

const admin = createAdminPool(config.adminDatabaseUrl);
try {
  const { email, role, tenant } = args.data;
  const result = await inviteUser(admin, { email, role });
  if (result.outcome === "exists") {
    console.error(`An account for that address already exists (role ${result.role}).`);
    process.exitCode = 1;
  } else {
    if (tenant !== undefined) await addMembership(admin, tenant, result.userId);
    console.log(
      `Invited as ${role}${tenant ? ` of tenant ${tenant}` : ""}. Their first login with that address becomes the account.`,
    );
  }
} finally {
  await admin.end();
}
