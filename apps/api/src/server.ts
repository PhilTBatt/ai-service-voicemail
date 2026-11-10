// The API process. Its routes and providers are set up in server-app.ts; this starts the
// process and stops it cleanly.
import { installAlertEmail } from "./alert-email.ts";
import { ConfigError, loadConfig, type Config } from "./config.ts";
import { createAdminPool } from "./db/cross-tenant.ts";
import { createPool } from "./db/pool.ts";
import { startQueue } from "./jobs/queue.ts";
import { logger } from "./logger.ts";
import { buildServerApp } from "./server-app.ts";

async function start(config: Config): Promise<void> {
  logger.level = config.logLevel;
  installAlertEmail(config);
  const pool = createPool(config.databaseUrl);
  // The API only enqueues; the worker process runs the jobs.
  const boss = await startQueue(config.databaseUrl);
  // The dashboard's cross-tenant views need the admin pool, and Clerk to say who's calling.
  const admin =
    config.clerkSecretKey && config.adminDatabaseUrl
      ? createAdminPool(config.adminDatabaseUrl)
      : undefined;
  const app = buildServerApp(config, { pool, boss, admin });

  const server = app.listen(config.port, (error) => {
    if (error) {
      logger.error("API failed to start", { error, port: config.port });
      process.exitCode = 1;
      void boss.stop({ close: true }).then(() => Promise.all([pool.end(), admin?.end()]));
      return;
    }
    logger.info("API listening", { port: config.port, nodeEnv: config.nodeEnv });
  });

  // Azure sends SIGTERM before stopping a container; Ctrl+C sends SIGINT. Stop accepting
  // connections, let in-flight requests finish, then close the queue and the pools.
  const shutdown = (signal: NodeJS.Signals) => {
    logger.info("Shutting down", { signal });
    server.close(() => {
      void boss
        .stop({ close: true })
        .then(() => Promise.all([pool.end(), admin?.end()]))
        .then(() => logger.info("Shutdown complete"));
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

try {
  await start(loadConfig(process.env));
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  logger.error("Invalid environment configuration", { problems: error.problems });
  process.exitCode = 1;
}
