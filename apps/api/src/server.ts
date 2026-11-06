import { createApp } from "./app.ts";
import { ConfigError, loadConfig, type Config } from "./config.ts";
import { createPool } from "./db/pool.ts";
import { logger } from "./logger.ts";
import { RetellVoiceProvider } from "./providers/retell.ts";

function start(config: Config): void {
  logger.level = config.logLevel;
  const pool = createPool(config.databaseUrl);

  const voiceProviders = config.retellApiKey
    ? { retell: new RetellVoiceProvider({ apiKey: config.retellApiKey }) }
    : {};
  if (!config.retellApiKey) logger.warn("RETELL_API_KEY not set: voice webhooks are disabled");

  const app = createApp({
    pool,
    voiceProviders,
    // Step 5 replaces this with storing the call and enqueueing its processing.
    onCallEnded: (event) => {
      logger.info("Voice call ended (not stored yet)", {
        providerCallId: event.providerCallId,
        providerAgentId: event.providerAgentId,
        durationSeconds: event.durationSeconds,
      });
      return Promise.resolve();
    },
  });

  const server = app.listen(config.port, (error) => {
    if (error) {
      logger.error("API failed to start", { error, port: config.port });
      process.exitCode = 1;
      void pool.end();
      return;
    }
    logger.info("API listening", { port: config.port, nodeEnv: config.nodeEnv });
  });

  // Azure sends SIGTERM before stopping a container; Ctrl+C sends SIGINT. Stop accepting
  // connections, let in-flight requests finish, then close the database pool.
  const shutdown = (signal: NodeJS.Signals) => {
    logger.info("Shutting down", { signal });
    server.close(() => {
      void pool.end().then(() => logger.info("Shutdown complete"));
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
