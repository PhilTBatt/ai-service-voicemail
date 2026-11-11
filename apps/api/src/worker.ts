// The worker process: runs background jobs. Same image as the API, different command. What it
// runs is set up in worker-jobs.ts; this starts the process and stops it cleanly.
import { installAlertEmail } from "./alert-email.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { createAdminPool } from "./db/cross-tenant.ts";
import { createPool } from "./db/pool.ts";
import {
  createScheduleCheck,
  registerScheduledRuns,
  startScheduleWatch,
} from "./db/scheduled-runs.ts";
import { recordHeartbeat, startHeartbeat } from "./db/worker-heartbeat.ts";
import { startQueue } from "./jobs/queue.ts";
import { logger } from "./logger.ts";
import { registerJobs } from "./worker-jobs.ts";

try {
  const config = loadConfig(process.env);
  logger.level = config.logLevel;
  installAlertEmail(config);
  if (!config.retellApiKey)
    throw new ConfigError(["RETELL_API_KEY is missing (the worker syncs agents to Retell)"]);

  const pool = createPool(config.databaseUrl);
  const admin = config.adminDatabaseUrl ? createAdminPool(config.adminDatabaseUrl) : null;
  const boss = await startQueue(config.databaseUrl);
  const queues = await registerJobs(
    { ...config, retellApiKey: config.retellApiKey },
    { boss, pool, admin },
  );
  // The check-in the health panel, /healthz/worker and npm run demo:profile read.
  const startedAt = new Date();
  const heartbeat = startHeartbeat(() => recordHeartbeat(pool, startedAt));
  // The recurring jobs on record, and a look every few minutes for one that's stopped.
  await registerScheduledRuns(pool, queues);
  const scheduleWatch = startScheduleWatch(createScheduleCheck({ pool, runsHere: queues }));
  logger.info("Worker listening", { queues, nodeEnv: config.nodeEnv });

  // Let the job in hand finish, then close the queue and both pools (Azure sends SIGTERM).
  const shutdown = (signal: NodeJS.Signals) => {
    logger.info("Worker shutting down", { signal });
    heartbeat.stop();
    scheduleWatch.stop();
    void boss
      .stop({ graceful: true, timeout: 30_000, close: true })
      .then(() => Promise.all([pool.end(), admin?.end()]))
      .then(() => logger.info("Worker shutdown complete"));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  logger.error("Invalid environment configuration", { problems: error.problems });
  process.exitCode = 1;
}
