import { execFileSync } from "node:child_process";
import { resolveBinary } from "dbmate";
import pg from "pg";
import { TEST_MIGRATION_DATABASE_URL } from "./databases.ts";

// Every tenant table, in one TRUNCATE so the foreign keys don't matter.
const TENANT_TABLES = [
  "tenants",
  "users",
  "tenant_memberships",
  "phone_numbers",
  "agent_profiles",
  "calls",
  "call_costs",
  "notifications",
  "usage_periods",
  "terms_acceptances",
  "audit_log",
  "blocked_numbers",
];

/**
 * Runs once before any test: brings the test database's schema up to date, as the owner,
 * then empties it. The test database keeps rows between runs (it's only wiped when its
 * container restarts), and tests that create tenants with random numbers would otherwise
 * collide with fixtures sooner or later.
 */
export default async function setup(): Promise<void> {
  try {
    execFileSync(
      resolveBinary(),
      [
        "--url",
        TEST_MIGRATION_DATABASE_URL,
        "--migrations-dir",
        "apps/api/src/db/migrations",
        "--no-dump-schema",
        "up",
      ],
      { stdio: "pipe" },
    );
  } catch (error) {
    const output = (error as { stderr?: Buffer }).stderr?.toString().trim();
    throw new Error(
      `Couldn't migrate the test database. Is it running? Start it with: npm run db:up\n${output ?? ""}`,
      { cause: error },
    );
  }

  const owner = new pg.Client({ connectionString: TEST_MIGRATION_DATABASE_URL });
  await owner.connect();
  try {
    await owner.query(`TRUNCATE ${TENANT_TABLES.join(", ")} CASCADE`);
    // Jobs too. Left over from earlier runs, they point at tenants just deleted, and a worker a
    // test starts has to get through all of them (failing, then retrying) before it reaches
    // the test's own job: hundreds had piled up, enough to time the sync test out. The queue
    // definitions stay; only queued, retrying and finished jobs go. The tables belong to the app
    // role, which the owner role is a member of.
    await owner.query("TRUNCATE pgboss.job, pgboss.job_dependency");
    // No worker has checked in at the start of a run (db/worker-heartbeat.ts): the tests that
    // need one record it, and the smoke tests show the admin a worker that isn't running.
    await owner.query("TRUNCATE worker_heartbeat");
    // Nor has any recurring job run (db/scheduled-runs.ts).
    await owner.query("TRUNCATE scheduled_runs");
  } finally {
    await owner.end();
  }
}
