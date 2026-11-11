// The API process. Its routes and providers are set up in server-app.ts; this starts the
// process and stops it cleanly.
//
// It listens straight away and connects the job queue alongside: if the database can't be
// reached at start-up (a restart, a failover), the API waits for it rather than exiting, and
// /readyz says "starting" until the queue is up, so Azure keeps traffic on the old revision
// during a release. Before, a start during a database blip threw, and Azure's restarts of a
// crashing container slowed down each time, keeping the API down after the database was back.
import { installAlertEmail } from "./alert-email.ts";
import { ConfigError, loadConfig, type Config } from "./config.ts";
import { createAdminPool } from "./db/cross-tenant.ts";
import { createPool } from "./db/pool.ts";
import { createQueue, startQueueWhenReachable } from "./jobs/queue.ts";
import { logger } from "./logger.ts";
import { buildServerApp } from "./server-app.ts";

function start(config: Config): void {
  logger.level = config.logLevel;
  installAlertEmail(config);
  const pool = createPool(config.databaseUrl);
  // The API only enqueues; the worker process runs the jobs.
  const boss = createQueue(config.databaseUrl);
  let queueReady = false;
  // The dashboard's cross-tenant views need the admin pool, and Clerk to say who's calling.
  const admin =
    config.clerkSecretKey && config.adminDatabaseUrl
      ? createAdminPool(config.adminDatabaseUrl)
      : undefined;
  const app = buildServerApp(config, { pool, boss, admin, ready: () => queueReady });

  const stopping = new AbortController();
  const closeAll = () =>
    boss.stop({ close: true }).then(() => Promise.all([pool.end(), admin?.end()]));

  const server = app.listen(config.port, (error) => {
    if (error) {
      logger.error("API failed to start", { error, port: config.port });
      process.exitCode = 1;
      stopping.abort();
      void closeAll();
      return;
    }
    logger.info("API listening", {
      port: config.port,
      nodeEnv: config.nodeEnv,
      version: config.appVersion,
    });
  });

  void startQueueWhenReachable(boss, { signal: stopping.signal }).then(
    (outcome) => {
      if (outcome !== "started") return;
      queueReady = true;
      logger.info("Job queue ready");
    },
    // pg-boss refusing its own configuration: waiting won't mend it. Stop, so it's seen.
    (error: unknown) => {
      logger.error("Job queue can't start; stopping the API", { error });
      process.exitCode = 1;
      stopping.abort();
      server.close(() => void closeAll());
    },
  );

  // Azure sends SIGTERM before stopping a container; Ctrl+C sends SIGINT. Stop accepting
  // connections, let in-flight requests finish, then close the queue and the pools.
  const shutdown = (signal: NodeJS.Signals) => {
    logger.info("Shutting down", { signal });
    stopping.abort();
    server.close(() => {
      void closeAll().then(() => logger.info("Shutdown complete"));
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

try {
  start(loadConfig(process.env));
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  logger.error("Invalid environment configuration", { problems: error.problems });
  process.exitCode = 1;
}
