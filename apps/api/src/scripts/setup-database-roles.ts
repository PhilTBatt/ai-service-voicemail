// Sets up the database's three logins on Azure (db/azure-roles.ts). Run by the callmate-db-setup
// job (Actions > Deploy > "database-setup"), once before the first migration; running it again
// only sets the passwords again. Connects as the server's admin (POSTGRES_ADMIN_URL). Prints
// no password or URL.
import pg from "pg";
import { roleLoginsFrom, setUpRoles } from "../db/azure-roles.ts";

const adminUrl = process.env.POSTGRES_ADMIN_URL;
if (!adminUrl) {
  console.error("POSTGRES_ADMIN_URL is missing");
  process.exit(1);
}

const logins = roleLoginsFrom(process.env);
const client = new pg.Client({ connectionString: adminUrl });
await client.connect();
try {
  await setUpRoles(client, logins);
  console.log(`Database logins ready: ${logins.map((login) => login.role).join(", ")}`);
} finally {
  await client.end();
}
