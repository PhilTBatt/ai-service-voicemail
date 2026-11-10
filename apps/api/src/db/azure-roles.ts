// The database's three logins on Azure (BUILD_PLAN Step 8, decision 004): what roles.sql does
// locally, where no login needs a password, with the real passwords. Each password comes from
// the connection URL that login is used with (Key Vault), so there's one place to set it.
// Run by scripts/setup-database-roles.ts, as the server's admin; safe to run again.
import { createHash } from "node:crypto";
import type pg from "pg";

/**
 * The first 8 hex digits of a secret's SHA-256: enough to tell two copies of a password apart
 * in a log without revealing it (a 24+ character random password can't be recovered from it).
 * The Deploy workflow prints the same of its POSTGRES_ADMIN_PASSWORD, so a mismatch between
 * GitHub's copy and Key Vault's shows up as two different fingerprints.
 */
export function fingerprint(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 8);
}

/** The password inside a connection URL, decoded (a URL's password has to be URL-encoded). */
export function passwordIn(connectionUrl: string): string {
  let url: URL;
  try {
    url = new URL(connectionUrl);
  } catch {
    throw new Error("isn't a URL");
  }
  return decodeURIComponent(url.password);
}

/** Each login, and the setting holding the connection URL it's used with. */
const LOGINS = [
  { role: "callmate_owner", setting: "MIGRATION_DATABASE_URL" },
  { role: "callmate_app", setting: "DATABASE_URL" },
  { role: "callmate_admin", setting: "ADMIN_DATABASE_URL" },
] as const;

export interface RoleLogin {
  role: (typeof LOGINS)[number]["role"];
  password: string;
}

/**
 * The three logins and their passwords, from the connection URLs. Refuses a URL for the wrong
 * login, or a short password: a mistake here would lock the app out, or leave it weak.
 */
export function roleLoginsFrom(env: Record<string, string | undefined>): RoleLogin[] {
  return LOGINS.map(({ role, setting }) => {
    const value = env[setting];
    if (!value) throw new Error(`${setting} is missing`);
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${setting} isn't a URL`);
    }
    if (decodeURIComponent(url.username) !== role) {
      throw new Error(`${setting} should log in as ${role}`);
    }
    const password = decodeURIComponent(url.password);
    if (password.length < 24) {
      throw new Error(`${setting}'s password should be at least 24 characters`);
    }
    return { role, password };
  });
}

/**
 * Creates each login, or sets its password if it exists, with the same rights roles.sql gives
 * it; then lets the owner create the job queue's objects as the app, and makes the owner own
 * the database. Statements, not parameters: CREATE ROLE takes no bind parameters, so the
 * names and passwords are quoted by the driver's own escaping.
 */
export async function setUpRoles(client: pg.ClientBase, logins: RoleLogin[]): Promise<void> {
  for (const { role, password } of logins) {
    const name = client.escapeIdentifier(role);
    const secret = client.escapeLiteral(password);
    const { rowCount } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
    await client.query(
      rowCount
        ? `ALTER ROLE ${name} WITH LOGIN PASSWORD ${secret}`
        : `CREATE ROLE ${name} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD ${secret}`,
    );
  }
  await client.query("GRANT callmate_app TO callmate_owner");
  // Handing the database to callmate_owner needs the admin to be able to act as it.
  await client.query("GRANT callmate_owner TO CURRENT_USER");
  const { rows } = await client.query<{ db: string }>("SELECT current_database() AS db");
  await client.query(
    `ALTER DATABASE ${client.escapeIdentifier(rows[0]!.db)} OWNER TO callmate_owner`,
  );
}
