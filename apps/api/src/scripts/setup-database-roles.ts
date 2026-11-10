// Sets up the database's three logins on Azure (db/azure-roles.ts). Run by the callmate-db-setup
// job (Actions > Deploy > "database-setup"), once before the first migration; running it again
// only sets the passwords again. Connects as the server's admin (POSTGRES_ADMIN_URL). Prints
// no password or URL: only the admin password's fingerprint, which the Deploy log also prints
// for GitHub's copy, so the two can be compared when the server turns the password down.
import pg from "pg";
import { fingerprint, passwordIn, roleLoginsFrom, setUpRoles } from "../db/azure-roles.ts";

const adminUrl = process.env.POSTGRES_ADMIN_URL;
if (!adminUrl) {
  console.error("POSTGRES_ADMIN_URL is missing");
  process.exit(1);
}

const logins = roleLoginsFrom(process.env);
console.log(
  `Admin password fingerprint: ${fingerprint(passwordIn(adminUrl))} (the Deploy log prints POSTGRES_ADMIN_PASSWORD's; they should match)`,
);

const client = new pg.Client({ connectionString: adminUrl });
try {
  await client.connect();
} catch (error) {
  if (error instanceof pg.DatabaseError && error.code === "28P01") {
    console.error(
      [
        "The server rejected postgres-admin-url's password.",
        "If its fingerprint above differs from the Deploy log's, GitHub's POSTGRES_ADMIN_PASSWORD and Key Vault's postgres-admin-url hold different passwords: set both from one copy.",
        "If they match, the server has a third password: reset it in the Azure portal (the server's Overview, Reset password) to that same one, then run database-setup again.",
      ].join("\n"),
    );
    process.exit(1);
  }
  throw error;
}
try {
  await setUpRoles(client, logins);
  console.log(`Database logins ready: ${logins.map((login) => login.role).join(", ")}`);
} finally {
  await client.end();
}
