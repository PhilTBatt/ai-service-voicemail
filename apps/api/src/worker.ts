// The worker process: runs background jobs. Same image as the API, different command.
import { ConfigError, loadConfig } from "./config.ts";
import { createPool } from "./db/pool.ts";
import { startDeadLetterWatcher } from "./jobs/dead-letter.ts";
import { runProcessCall, type ProcessCallJobData } from "./jobs/process-call.ts";
import {
  PROCESS_CALL_QUEUE,
  RECONCILE_VOICEMAILS_CRON,
  RECONCILE_VOICEMAILS_QUEUE,
  SYNC_AGENT_QUEUE,
  startQueue,
} from "./jobs/queue.ts";
import { reconcileVoicemails } from "./jobs/reconcile-voicemails.ts";
import { runSyncAgent, type SyncAgentJobData } from "./jobs/sync-agent.ts";
import { logger } from "./logger.ts";
import { AnthropicLlmProvider } from "./providers/anthropic.ts";
import { RetellVoiceProvider } from "./providers/retell.ts";
import { TwilioTelephonyProvider } from "./providers/twilio.ts";

try {
  const config = loadConfig(process.env);
  logger.level = config.logLevel;
  if (!config.retellApiKey)
    throw new ConfigError(["RETELL_API_KEY is missing (the worker syncs agents to Retell)"]);

  const pool = createPool(config.databaseUrl);
  const boss = await startQueue(config.databaseUrl);
  const voice = new RetellVoiceProvider({ apiKey: config.retellApiKey });
  const queues = [SYNC_AGENT_QUEUE, "dead-letter"];
  await startDeadLetterWatcher(boss);

  await boss.work<SyncAgentJobData>(SYNC_AGENT_QUEUE, async (jobs) => {
    for (const job of jobs) await runSyncAgent({ pool, voice }, job.data);
  });

  if (config.llm) {
    const llm = new AnthropicLlmProvider(config.llm);
    await boss.work<ProcessCallJobData>(PROCESS_CALL_QUEUE, async (jobs) => {
      for (const job of jobs) await runProcessCall({ pool, llm }, job.data);
    });
    queues.push(PROCESS_CALL_QUEUE);
  } else {
    logger.warn("Call processing disabled: ANTHROPIC_API_KEY isn't set (jobs wait in the queue)");
  }

  if (config.twilio) {
    const telephony = new TwilioTelephonyProvider(config.twilio);
    await boss.work(RECONCILE_VOICEMAILS_QUEUE, async () => {
      await reconcileVoicemails({ pool, telephony });
    });
    await boss.schedule(RECONCILE_VOICEMAILS_QUEUE, RECONCILE_VOICEMAILS_CRON, null, {
      tz: "Europe/London",
    });
    queues.push(RECONCILE_VOICEMAILS_QUEUE);
  } else {
    logger.warn("Voicemail reconciliation disabled: Twilio isn't configured");
  }
  logger.info("Worker listening", { queues, nodeEnv: config.nodeEnv });

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
