import { createApp } from "./app.ts";
import { ConfigError, loadConfig, retellUrls, type Config } from "./config.ts";
import { recordCallEnded, recordMidCallEmergency } from "./db/calls.ts";
import { createPool } from "./db/pool.ts";
import { enqueueNotificationsWith } from "./jobs/enqueue-notifications.ts";
import { startQueue } from "./jobs/queue.ts";
import { enqueueSyncAgent, type SyncAgentJobData } from "./jobs/sync-agent.ts";
import { logger } from "./logger.ts";
import { RetellVoiceProvider } from "./providers/retell.ts";
import { TwilioTelephonyProvider } from "./providers/twilio.ts";

async function start(config: Config): Promise<void> {
  logger.level = config.logLevel;
  const pool = createPool(config.databaseUrl);
  // The API only enqueues; the worker process runs the jobs.
  const boss = await startQueue(config.databaseUrl);

  const voiceProviders = config.retellApiKey
    ? { retell: new RetellVoiceProvider({ apiKey: config.retellApiKey, ...retellUrls(config) }) }
    : {};
  if (!config.retellApiKey) logger.warn("RETELL_API_KEY not set: voice webhooks are disabled");

  // Call routing needs all three: Twilio to verify its webhooks, the public URL they were
  // signed for, and Retell to hand calls to.
  const retell = voiceProviders.retell;
  const telephony =
    config.twilio && config.publicBaseUrl && retell
      ? {
          provider: new TwilioTelephonyProvider(config.twilio),
          voice: retell,
          publicBaseUrl: config.publicBaseUrl,
          outbound: config.outbound,
          enqueueSync: (job: SyncAgentJobData) => enqueueSyncAgent(boss, job),
          enqueueNotifications: enqueueNotificationsWith(boss),
        }
      : undefined;
  if (!telephony) {
    logger.warn(
      "Call routing disabled: needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, PUBLIC_BASE_URL and RETELL_API_KEY",
    );
  }

  if (!config.signingSecret) logger.warn("Call pages disabled: SIGNING_SECRET isn't set");
  // The login provider is still to be chosen (decision 012). Once it is, its adapter goes in
  // here with the admin pool, and createApp gets a `dashboard` option.
  logger.warn("Dashboard API disabled: no login provider configured yet (decision 012)");

  const app = createApp({
    pool,
    voiceProviders,
    telephony,
    postmark: config.postmarkWebhookSecret
      ? { webhookSecret: config.postmarkWebhookSecret }
      : undefined,
    callPages: config.signingSecret
      ? { signingSecret: config.signingSecret, telephony: telephony?.provider, voice: retell }
      : undefined,
    onFunctionCall: async (event) => {
      const result = await recordMidCallEmergency(pool, boss, event);
      logger.info("Mid-call function handled", {
        name: event.name,
        providerCallId: event.providerCallId,
        outcome: result.outcome,
      });
    },
    onCallEnded: async (event) => {
      const result = await recordCallEnded(pool, boss, event);
      logger.info("Voice call ended", { providerCallId: event.providerCallId, ...result });
    },
  });

  const server = app.listen(config.port, (error) => {
    if (error) {
      logger.error("API failed to start", { error, port: config.port });
      process.exitCode = 1;
      void boss.stop({ close: true }).then(() => pool.end());
      return;
    }
    logger.info("API listening", { port: config.port, nodeEnv: config.nodeEnv });
  });

  // Azure sends SIGTERM before stopping a container; Ctrl+C sends SIGINT. Stop accepting
  // connections, let in-flight requests finish, then close the queue and the pool.
  const shutdown = (signal: NodeJS.Signals) => {
    logger.info("Shutting down", { signal });
    server.close(() => {
      void boss
        .stop({ close: true })
        .then(() => pool.end())
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
