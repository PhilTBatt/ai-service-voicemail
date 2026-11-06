// The worker process: runs background jobs. Same image as the API, different command.
import { ConfigError, loadConfig } from "./config.ts";
import { createPool } from "./db/pool.ts";
import { SYNC_AGENT_QUEUE, startQueue } from "./jobs/queue.ts";
import { runSyncAgent, type SyncAgentJobData } from "./jobs/sync-agent.ts";
import { logger } from "./logger.ts";
import { RetellVoiceProvider } from "./providers/retell.ts";

try {
  const config = loadConfig(process.env);
  logger.level = config.logLevel;
  if (!config.retellApiKey)
    throw new ConfigError(["RETELL_API_KEY is missing (the worker syncs agents to Retell)"]);

  const pool = createPool(config.databaseUrl);
  const boss = await startQueue(config.databaseUrl);
  const voice = new RetellVoiceProvider({ apiKey: config.retellApiKey });

  await boss.work<SyncAgentJobData>(SYNC_AGENT_QUEUE, async (jobs) => {
    for (const job of jobs) await runSyncAgent({ pool, voice }, job.data);
  });
  logger.info("Worker listening", { queues: [SYNC_AGENT_QUEUE], nodeEnv: config.nodeEnv });

  // Let the job in hand finish, then close the queue and the pool (Azure sends SIGTERM).
  const shutdown = (signal: NodeJS.Signals) => {
    logger.info("Worker shutting down", { signal });
    void boss
      .stop({ graceful: true, timeout: 30_000, close: true })
      .then(() => pool.end())
      .then(() => logger.info("Worker shutdown complete"));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  logger.error("Invalid environment configuration", { problems: error.problems });
  process.exitCode = 1;
}
