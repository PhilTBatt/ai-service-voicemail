// What the worker runs, given its settings: each queue's job handler, and the recurring jobs.
// Kept apart from worker.ts, which only starts and stops the process, so a test can check the
// wiring (worker-jobs.test.ts): that every queue gets a worker once its provider is set up.
import type { PgBoss, ScheduleOptions } from "pg-boss";
import type pg from "pg";
import { retellUrls, type Config } from "./config.ts";
import type { AdminPool } from "./db/cross-tenant.ts";
import { trackRun } from "./db/scheduled-runs.ts";
import {
  enqueueBillingEmailWith,
  runBillingEmail,
  type BillingEmailJobData,
} from "./jobs/billing-email.ts";
import { runChargePeriods } from "./jobs/charge-periods.ts";
import { startDeadLetterWatcher } from "./jobs/dead-letter.ts";
import { enqueueNotificationsWith } from "./jobs/enqueue-notifications.ts";
import { runNotifyEmail, type NotifyEmailJobData } from "./jobs/notify-email.ts";
import { runNotifyEmergency, type NotifyEmergencyJobData } from "./jobs/notify-emergency.ts";
import { runNotifySms, type NotifySmsJobData } from "./jobs/notify-sms.ts";
import { runOffboardingJob, type OffboardingJobData } from "./jobs/offboarding.ts";
import {
  enqueueOnboardingWith,
  runOnboardingJob,
  type OnboardingJobData,
} from "./jobs/onboarding.ts";
import { runProcessCall, type ProcessCallJobData } from "./jobs/process-call.ts";
import {
  BILLING_EMAIL_QUEUE,
  CHARGE_PERIODS_CRON,
  CHARGE_PERIODS_QUEUE,
  DEAD_LETTER_QUEUE,
  NOTIFY_EMAIL_QUEUE,
  NOTIFY_EMERGENCY_QUEUE,
  NOTIFY_SMS_QUEUE,
  OFFBOARDING_QUEUE,
  ONBOARDING_QUEUE,
  PROCESS_CALL_QUEUE,
  RECONCILE_CALLS_CRON,
  RECONCILE_CALLS_QUEUE,
  RECONCILE_VOICEMAILS_CRON,
  RECONCILE_VOICEMAILS_QUEUE,
  RETENTION_CRON,
  RETENTION_QUEUE,
  SYNC_AGENT_QUEUE,
} from "./jobs/queue.ts";
import { reconcileCalls } from "./jobs/reconcile-calls.ts";
import { reconcileVoicemails } from "./jobs/reconcile-voicemails.ts";
import { runRetention } from "./jobs/retention.ts";
import { runSyncAgent, type SyncAgentJobData } from "./jobs/sync-agent.ts";
import { logger } from "./logger.ts";
import { AnthropicLlmProvider } from "./providers/anthropic.ts";
import { ClerkAuthProvider } from "./providers/clerk.ts";
import { GoCardlessPaymentsProvider } from "./providers/gocardless.ts";
import { PostmarkEmailProvider } from "./providers/postmark.ts";
import { RetellVoiceProvider } from "./providers/retell.ts";
import { TwilioSmsProvider } from "./providers/twilio-sms.ts";
import { TwilioTelephonyProvider } from "./providers/twilio.ts";

/**
 * How the four recurring jobs are scheduled: on UK time, and a run that came due while nothing
 * was checking the schedules is sent once when something is back, rather than skipped (pg-boss's
 * default). The API's pg-boss checks them too, so a worker that's down alone loses nothing: the
 * API queues the run and the worker takes it when it's back. This is for both being down at
 * once, or the database. Each job catches up to now in one run, so once is enough: billing
 * charges every ended month not yet charged, retention clears everything due.
 */
const SCHEDULE_OPTIONS: ScheduleOptions = { tz: "Europe/London", missed: "once" };

/**
 * Gives each queue its worker, as far as the settings allow, and returns the queues that got
 * one. A queue without one keeps its jobs waiting (and says so in the log) until its provider
 * is set up: nothing is lost.
 */
export async function registerJobs(
  config: Config & { retellApiKey: string },
  { boss, pool, admin }: { boss: PgBoss; pool: pg.Pool; admin: AdminPool | null },
): Promise<string[]> {
  // The worker syncs agents, so it decides their webhook and function URLs.
  const voice = new RetellVoiceProvider({ apiKey: config.retellApiKey, ...retellUrls(config) });
  if (!config.publicBaseUrl) {
    logger.warn("PUBLIC_BASE_URL isn't set: agents sync without webhook or function URLs");
  }
  const queues: string[] = [SYNC_AGENT_QUEUE, DEAD_LETTER_QUEUE];
  await startDeadLetterWatcher(boss);
  const enqueueNotifications = enqueueNotificationsWith(boss);

  await boss.work<SyncAgentJobData>(SYNC_AGENT_QUEUE, async (jobs) => {
    for (const job of jobs) await runSyncAgent({ pool, voice }, job.data);
  });

  if (config.llm) {
    const llm = new AnthropicLlmProvider(config.llm);
    const { judgeSampleRate } = config.llm;
    await boss.work<ProcessCallJobData>(PROCESS_CALL_QUEUE, async (jobs) => {
      for (const job of jobs) {
        await runProcessCall({ pool, llm, enqueueNotifications, judgeSampleRate }, job.data);
      }
    });
    queues.push(PROCESS_CALL_QUEUE);
  } else {
    logger.warn("Call processing disabled: ANTHROPIC_API_KEY isn't set (jobs wait in the queue)");
  }

  if (config.sms && config.signingSecret && config.publicBaseUrl) {
    const deps = {
      pool,
      sms: new TwilioSmsProvider({
        ...config.sms,
        statusCallbackUrl: `${config.publicBaseUrl}/webhooks/twilio/sms-status`,
      }),
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
    // Onboarding texts, and going live after the test call (which then texts).
    await boss.work<OnboardingJobData>(ONBOARDING_QUEUE, async (jobs) => {
      for (const job of jobs) {
        await runOnboardingJob({ ...deps, dashboardOrigin: config.dashboardOrigin }, job.data);
      }
    });
    // When a business leaves: the text, and the email where email is set up.
    const leavingEmail = config.email ? new PostmarkEmailProvider(config.email) : undefined;
    // Deleting a business's data needs the admin pool and Twilio as well as Retell, and Clerk
    // for the logins. The worker never checks a login token, so it names no sites for one.
    const deletion =
      admin && config.twilio
        ? {
            admin,
            voice,
            telephony: new TwilioTelephonyProvider(config.twilio),
            auth: config.clerkSecretKey
              ? new ClerkAuthProvider({ secretKey: config.clerkSecretKey, authorizedParties: [] })
              : undefined,
            // The Direct Debit is cancelled when the data goes (Step 12).
            payments: config.payments ? new GoCardlessPaymentsProvider(config.payments) : undefined,
          }
        : undefined;
    await boss.work<OffboardingJobData>(OFFBOARDING_QUEUE, async (jobs) => {
      for (const job of jobs) {
        await runOffboardingJob({ ...deps, email: leavingEmail, deletion }, job.data);
      }
    });
    queues.push(NOTIFY_EMERGENCY_QUEUE, NOTIFY_SMS_QUEUE, ONBOARDING_QUEUE, OFFBOARDING_QUEUE);
  } else {
    logger.warn(
      "SMS notifications disabled: needs TWILIO_SMS_FROM, SIGNING_SECRET and PUBLIC_BASE_URL (jobs wait in the queue)",
    );
  }

  if (config.email && config.signingSecret && config.publicBaseUrl) {
    const deps = {
      pool,
      email: new PostmarkEmailProvider(config.email),
      outbound: config.outbound,
      signingSecret: config.signingSecret,
      publicBaseUrl: config.publicBaseUrl,
    };
    await boss.work<NotifyEmailJobData>(NOTIFY_EMAIL_QUEUE, async (jobs) => {
      for (const job of jobs) await runNotifyEmail(deps, job.data);
    });
    // Receipts, failed payments and ended Direct Debits (Step 12).
    await boss.work<BillingEmailJobData>(BILLING_EMAIL_QUEUE, async (jobs) => {
      for (const job of jobs) {
        await runBillingEmail({ ...deps, dashboardOrigin: config.dashboardOrigin }, job.data);
      }
    });
    queues.push(NOTIFY_EMAIL_QUEUE, BILLING_EMAIL_QUEUE);
  } else {
    logger.warn(
      "Email notifications disabled: needs POSTMARK_SERVER_TOKEN, EMAIL_FROM, SIGNING_SECRET and PUBLIC_BASE_URL (jobs wait in the queue)",
    );
  }

  if (admin && config.payments) {
    // Charging (Step 12): each paying business's ended billing months, every morning.
    const payments = new GoCardlessPaymentsProvider(config.payments);
    const enqueueBillingEmail = enqueueBillingEmailWith(boss);
    await boss.work(CHARGE_PERIODS_QUEUE, () =>
      trackRun(pool, CHARGE_PERIODS_QUEUE, () =>
        runChargePeriods({ pool, admin, payments, enqueueBillingEmail, vat: config.vat ?? null }),
      ),
    );
    await boss.schedule(CHARGE_PERIODS_QUEUE, CHARGE_PERIODS_CRON, null, SCHEDULE_OPTIONS);
    queues.push(CHARGE_PERIODS_QUEUE);
  } else {
    logger.warn("Charging disabled: needs GOCARDLESS_ACCESS_TOKEN and ADMIN_DATABASE_URL");
  }

  if (admin) {
    // Agent calls whose webhook never arrived (and provisional mid-call rows): stored every 15 min.
    await boss.work(RECONCILE_CALLS_QUEUE, () =>
      trackRun(pool, RECONCILE_CALLS_QUEUE, () => reconcileCalls({ pool, admin, boss, voice })),
    );
    await boss.schedule(RECONCILE_CALLS_QUEUE, RECONCILE_CALLS_CRON, null, SCHEDULE_OPTIONS);
    queues.push(RECONCILE_CALLS_QUEUE);
  } else {
    logger.warn("Call reconciliation disabled: ADMIN_DATABASE_URL isn't set");
  }

  if (config.twilio) {
    const telephony = new TwilioTelephonyProvider(config.twilio);
    const enqueueOnboarding = enqueueOnboardingWith(boss);
    await boss.work(RECONCILE_VOICEMAILS_QUEUE, () =>
      trackRun(pool, RECONCILE_VOICEMAILS_QUEUE, () =>
        reconcileVoicemails({ pool, telephony, enqueueNotifications, enqueueOnboarding }),
      ),
    );
    await boss.schedule(
      RECONCILE_VOICEMAILS_QUEUE,
      RECONCILE_VOICEMAILS_CRON,
      null,
      SCHEDULE_OPTIONS,
    );
    queues.push(RECONCILE_VOICEMAILS_QUEUE);

    if (admin) {
      await boss.work(RETENTION_QUEUE, () =>
        trackRun(pool, RETENTION_QUEUE, () => runRetention({ admin, voice, telephony })),
      );
      await boss.schedule(RETENTION_QUEUE, RETENTION_CRON, null, SCHEDULE_OPTIONS);
      queues.push(RETENTION_QUEUE);
    } else {
      logger.warn("Retention disabled: ADMIN_DATABASE_URL isn't set");
    }
  } else {
    logger.warn("Voicemail reconciliation and retention disabled: Twilio isn't configured");
  }
  return queues;
}
