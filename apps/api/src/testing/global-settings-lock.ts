// The kill switch is one row for the whole service (system_settings), so test files that turn
// it on, or need it off, can't run at the same time: Vitest runs test files in parallel, and
// CI caught twilio.test.ts resetting it in the middle of dashboard.test.ts's check, and a call
// routed to the voicemail while dashboard.test.ts had it on. Each such file holds this lock for
// its whole run (beforeAll to afterAll), so they take turns while every other file runs
// alongside. A Postgres advisory lock, so it holds across Vitest's worker processes.
import pg from "pg";
import { TEST_DATABASE_URL } from "./databases.ts";

/** Any fixed number: the lock's name. */
const GLOBAL_SETTINGS_LOCK = 4_720_011;

/** Long enough to wait for another file to finish (its whole run). */
export const GLOBAL_SETTINGS_LOCK_TIMEOUT_MS = 120_000;

/** Waits for the lock, holds it on a connection of its own, and returns how to let it go. */
export async function holdGlobalSettings(): Promise<() => Promise<void>> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  await client.query("SELECT pg_advisory_lock($1)", [GLOBAL_SETTINGS_LOCK]);
  return async () => {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [GLOBAL_SETTINGS_LOCK]);
    } finally {
      await client.end();
    }
  };
}
