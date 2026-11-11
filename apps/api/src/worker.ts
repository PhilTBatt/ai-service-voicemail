// The worker process: runs background jobs. Same image as the API, different command. What it
// runs is set up in worker-jobs.ts; this starts the process and stops it cleanly.
//
// If the database can't be reached at start-up it waits for it, as the API does (server.ts),
// rather than exiting into a slowing restart loop. Until the queue is up it doesn't check in,
// so /healthz/worker and the Admin page say it's down, which is true.
import { installAlertEmail } from "./alert-email.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { createAdminPool } from "./db/cross-tenant.ts";
import { WORKER_ADMIN_POOL_MAX, createPool } from "./db/pool.ts";
import {
  createScheduleCheck,
  registerScheduledRuns,
  startScheduleWatch,
} from "./db/scheduled-runs.ts";
import { recordHeartbeat, startHeartbeat } from "./db/worker-heartbeat.ts";
import { createQueue, startQueueWhenReachable } from "./jobs/queue.ts";
import { logger } from "./logger.ts";
import { registerJobs } from "./worker-jobs.ts";

try {
  const config = loadConfig(process.env);
  logger.level = config.logLevel;
  installAlertEmail(config);
  if (!config.retellApiKey)
    throw new ConfigError(["RETELL_API_KEY is missing (the worker syncs agents to Retell)"]);

  const pool = createPool(config.databaseUrl);
  const admin = config.adminDatabaseUrl
    ? createAdminPool(config.adminDatabaseUrl, { max: WORKER_ADMIN_POOL_MAX })
    : null;
  const boss = createQueue(config.databaseUrl);
  const stopping = new AbortController();
  let stopTimers = () => {};

  // Let the job in hand finish, then close the queue and both pools (Azure sends SIGTERM).
  // Registered before the queue starts, so a stop while it's still waiting for the database
  // ends the wait too.
  const shutdown = (signal: NodeJS.Signals) => {
    logger.info("Worker shutting down", { signal });
    stopping.abort();
    stopTimers();
    void boss
      .stop({ graceful: true, timeout: 30_000, close: true })
      .then(() => Promise.all([pool.end(), admin?.end()]))
      .then(() => logger.info("Worker shutdown complete"));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  if ((await startQueueWhenReachable(boss, { signal: stopping.signal })) === "started") {
    const queues = await registerJobs(
      { ...config, retellApiKey: config.retellApiKey },
      { boss, pool, admin },
    );
    // The check-in the health panel, /healthz/worker and npm run demo:profile read, with the
    // build it runs, which the release check waits for.
    const startedAt = new Date();
    const heartbeat = startHeartbeat(() =>
      recordHeartbeat(pool, startedAt, config.appVersion ?? null),
    );
    // The recurring jobs on record, and a look every few minutes for one that's stopped.
    await registerScheduledRuns(pool, queues);
    const scheduleWatch = startScheduleWatch(createScheduleCheck({ pool, runsHere: queues }));
    stopTimers = () => {
      heartbeat.stop();
      scheduleWatch.stop();
    };
    logger.info("Worker listening", {
      queues,
      nodeEnv: config.nodeEnv,
      version: config.appVersion,
    });
  }
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  logger.error("Invalid environment configuration", { problems: error.problems });
  process.exitCode = 1;
}
