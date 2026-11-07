import pg from "pg";
import { logger } from "../logger.ts";

/** One pool per process. It connects lazily, on the first query. */
export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
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
