// The worker process: runs background jobs. Same image as the API, different command.
import { ConfigError, loadConfig } from "./config.ts";
import { createAdminPool } from "./db/cross-tenant.ts";
import { createPool } from "./db/pool.ts";
import { startDeadLetterWatcher } from "./jobs/dead-letter.ts";
import { enqueueNotificationsWith } from "./jobs/enqueue-notifications.ts";
import { runNotifyEmergency, type NotifyEmergencyJobData } from "./jobs/notify-emergency.ts";
import { runNotifySms, type NotifySmsJobData } from "./jobs/notify-sms.ts";
import { runProcessCall, type ProcessCallJobData } from "./jobs/process-call.ts";
import {
  NOTIFY_EMERGENCY_QUEUE,
  NOTIFY_SMS_QUEUE,
  PROCESS_CALL_QUEUE,
  RECONCILE_VOICEMAILS_CRON,
  RECONCILE_VOICEMAILS_QUEUE,
  RETENTION_CRON,
  RETENTION_QUEUE,
  SYNC_AGENT_QUEUE,
  startQueue,
} from "./jobs/queue.ts";
import { reconcileVoicemails } from "./jobs/reconcile-voicemails.ts";
import { runRetention } from "./jobs/retention.ts";
import { runSyncAgent, type SyncAgentJobData } from "./jobs/sync-agent.ts";
import { logger } from "./logger.ts";
import { AnthropicLlmProvider } from "./providers/anthropic.ts";
import { RetellVoiceProvider } from "./providers/retell.ts";
import { TwilioSmsProvider } from "./providers/twilio-sms.ts";
import { TwilioTelephonyProvider } from "./providers/twilio.ts";

try {
  const config = loadConfig(process.env);
  logger.level = config.logLevel;
  if (!config.retellApiKey)
    throw new ConfigError(["RETELL_API_KEY is missing (the worker syncs agents to Retell)"]);

  const pool = createPool(config.databaseUrl);
  const boss = await startQueue(config.databaseUrl);
  // The worker syncs agents, so it decides their webhook and function URLs.
  const voice = new RetellVoiceProvider({
    apiKey: config.retellApiKey,
    ...(config.publicBaseUrl
      ? {
          webhookUrl: `${config.publicBaseUrl}/webhooks/voice/retell`,
          functionUrl: `${config.publicBaseUrl}/webhooks/voice/retell/function`,
        }
      : {}),
  });
  if (!config.publicBaseUrl) {
    logger.warn("PUBLIC_BASE_URL isn't set: agents sync without webhook or function URLs");
  }
  const queues = [SYNC_AGENT_QUEUE, "dead-letter"];
  await startDeadLetterWatcher(boss);
  const enqueueNotifications = enqueueNotificationsWith(boss);

  await boss.work<SyncAgentJobData>(SYNC_AGENT_QUEUE, async (jobs) => {
    for (const job of jobs) await runSyncAgent({ pool, voice }, job.data);
  });

  if (config.llm) {
    const llm = new AnthropicLlmProvider(config.llm);
    await boss.work<ProcessCallJobData>(PROCESS_CALL_QUEUE, async (jobs) => {
      for (const job of jobs) {
        await runProcessCall(
          {
            pool,
            llm,
            enqueueNotifications,
          },
          job.data,
        );
      }
    });
    queues.push(PROCESS_CALL_QUEUE);
  } else {
    logger.warn("Call processing disabled: ANTHROPIC_API_KEY isn't set (jobs wait in the queue)");
  }

  if (config.sms && config.signingSecret && config.publicBaseUrl) {
    const deps = {
      pool,
      sms: new TwilioSmsProvider(config.sms),
      outbound: config.outbound,
      signingSecret: config.signingSecret,
      publicBaseUrl: config.publicBaseUrl,
    };
    await boss.work<NotifyEmergencyJobData>(NOTIFY_EMERGENCY_QUEUE, async (jobs) => {
      for (const job of jobs) await runNotifyEmergency(deps, job.data);
    });
    await boss.work<NotifySmsJobData>(NOTIFY_SMS_QUEUE, async (jobs) => {
      for (const job of jobs) await runNotifySms(deps, job.data);
    });
    queues.push(NOTIFY_EMERGENCY_QUEUE, NOTIFY_SMS_QUEUE);
  } else {
    logger.warn(
      "SMS notifications disabled: needs TWILIO_SMS_FROM, SIGNING_SECRET and PUBLIC_BASE_URL (jobs wait in the queue)",
    );
  }

  // No email adapter until Phil picks a provider (decision 010); the jobs wait in the queue.
  logger.warn(
    "Email notifications disabled: no email provider configured yet (jobs wait in the queue)",
  );

  if (config.twilio) {
    const telephony = new TwilioTelephonyProvider(config.twilio);
    await boss.work(RECONCILE_VOICEMAILS_QUEUE, async () => {
      await reconcileVoicemails({ pool, telephony, enqueueNotifications });
    });
    await boss.schedule(RECONCILE_VOICEMAILS_QUEUE, RECONCILE_VOICEMAILS_CRON, null, {
      tz: "Europe/London",
    });
    queues.push(RECONCILE_VOICEMAILS_QUEUE);

    if (config.adminDatabaseUrl) {
      const admin = createAdminPool(config.adminDatabaseUrl);
      await boss.work(RETENTION_QUEUE, async () => {
        await runRetention({ admin, voice, telephony });
      });
      await boss.schedule(RETENTION_QUEUE, RETENTION_CRON, null, { tz: "Europe/London" });
      queues.push(RETENTION_QUEUE);
    } else {
      logger.warn("Retention disabled: ADMIN_DATABASE_URL isn't set");
    }
  } else {
    logger.warn("Voicemail reconciliation and retention disabled: Twilio isn't configured");
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
