import pg from "pg";
import { logger } from "../logger.ts";

/**
 * Connections each process may hold, per pool. Production's database (Azure B1ms) takes 35
 * user connections in all (learn.microsoft.com/azure/postgresql/flexible-server/concepts-limits),
 * and pg's default of 10 a pool, three pools a process (app, admin, the job queue), let one
 * release (old and new copies of the API and the worker running at once, plus the migration
 * job) ask for over 100: the next connection refused, the call route answering 500, callers
 * sent to the fallback voicemail. Now 4 + 2 + 2 = 8 for the API and 4 + 3 + 2 = 9 for the
 * worker (whose admin pool holds one connection through a whole deletion, under its advisory
 * lock), with the API kept to one copy (infra/main.bicep): 17 in normal running, 34 at the peak
 * of a release plus the migration job's one. The load test (npm run load) passes at these sizes.
 *
 * The one-off task job (callmate-task: the Deploy workflow's "task" step) runs one script from
 * apps/api/src/scripts with pools of its own, at most one of each at its default size
 * (create-demo-business has all three): 4 + 2 + 2 = 8 more, so 25 while a task runs. It shares
 * the deploy-production concurrency group with a release, and its step waits for the script to
 * finish, so a task never runs during a release and the peak stays 35. Run while a release is
 * going (by hand from the Azure portal, say), it would ask for 43 and be refused connections.
 */
export const APP_POOL_MAX = 4;
export const ADMIN_POOL_MAX = 2;
export const WORKER_ADMIN_POOL_MAX = 3;
export const QUEUE_POOL_MAX = 2;

/** One pool per process. It connects lazily, on the first query. */
export function createPool(connectionString: string, { max = APP_POOL_MAX } = {}): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max,
    // pg's default is to wait forever for a connection, which would hang requests
    // (and readiness checks) whenever the database is unreachable.
    connectionTimeoutMillis: 2_000,
    // A query that never returns would otherwise hold a Twilio webhook past its 15-second
    // limit, or a job past its expiry. Nothing here should take anywhere near this long.
    statement_timeout: 10_000,
  });

  // Idle connections emit errors when the database restarts or the network drops. With no
  // listener, Node treats that as an uncaught error and crashes the whole process.
  pool.on("error", (error) => {
    logger.warn("Idle database connection failed", { error });
  });

  return pool;
}
