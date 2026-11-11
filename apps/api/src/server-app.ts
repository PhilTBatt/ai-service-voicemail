// The API, given its settings: which routes are on, and the providers behind them. Kept apart
// from server.ts, which only starts and stops the process, so a test can check the wiring
// (server-app.test.ts): that each route is on once its settings are there, and off without.
import type { PgBoss } from "pg-boss";
import type pg from "pg";
import { createApp } from "./app.ts";
import { retellUrls, type Config } from "./config.ts";
import { recordCallEnded, recordMidCallEmergency } from "./db/calls.ts";
import type { AdminPool } from "./db/cross-tenant.ts";
import { enqueueBillingEmailWith } from "./jobs/billing-email.ts";
import { enqueueNotificationsWith } from "./jobs/enqueue-notifications.ts";
import { enqueueOnboardingWith } from "./jobs/onboarding.ts";
import { enqueueSyncAgent, type SyncAgentJobData } from "./jobs/sync-agent.ts";
import { logger } from "./logger.ts";
import { ClerkAuthProvider } from "./providers/clerk.ts";
import { GoCardlessPaymentsProvider } from "./providers/gocardless.ts";
import { RetellVoiceProvider } from "./providers/retell.ts";
import { TwilioTelephonyProvider } from "./providers/twilio.ts";

/**
 * The API's routes and providers. `admin` is the cross-tenant pool, which the dashboard needs:
 * the caller creates it (and closes it) when CLERK_SECRET_KEY and ADMIN_DATABASE_URL are set.
 */
export function buildServerApp(
  config: Config,
  { pool, boss, admin }: { pool: pg.Pool; boss: PgBoss; admin: AdminPool | undefined },
) {
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
          alternateBaseUrl: config.alternateBaseUrl,
          outbound: config.outbound,
          enqueueSync: (job: SyncAgentJobData) => enqueueSyncAgent(boss, job),
          enqueueNotifications: enqueueNotificationsWith(boss),
          enqueueOnboarding: enqueueOnboardingWith(boss),
        }
      : undefined;
  if (!telephony) {
    logger.warn(
      "Call routing disabled: needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, PUBLIC_BASE_URL and RETELL_API_KEY",
    );
  }

  if (!config.signingSecret) logger.warn("Call pages disabled: SIGNING_SECRET isn't set");
  // Direct Debit (Step 12): the dashboard starts set-ups, and the webhook hears what happened.
  const payments = config.payments ? new GoCardlessPaymentsProvider(config.payments) : undefined;
  if (!payments) logger.warn("Billing disabled: GOCARDLESS_ACCESS_TOKEN isn't set");
  else {
    if (!config.payments?.webhookSecret) {
      logger.warn("Payments webhooks refused: GOCARDLESS_WEBHOOK_SECRET isn't set");
    }
    if (config.nodeEnv === "production" && payments.environment === "sandbox") {
      logger.warn(
        "Payments are on GoCardless's sandbox: no real money moves (GOCARDLESS_ENVIRONMENT)",
      );
    }
  }
  // Retell signs webhooks with the one key marked "webhook" in its dashboard. Without
  // RETELL_WEBHOOK_KEY the API key is used, which works only if that key carries the badge;
  // if not, every call-ended webhook is refused, and calls arrive late through reconciliation.
  if (config.nodeEnv === "production" && config.retellApiKey && !config.retellWebhookKey) {
    logger.warn(
      "RETELL_WEBHOOK_KEY isn't set: Retell's webhooks are checked with RETELL_API_KEY, which works only if that key has the webhook badge in Retell's dashboard",
    );
  }
  // The dashboard API (/api) needs Clerk to say who is calling, and the admin pool for the
  // views that span tenants (the tenant list, the admin screens).
  const dashboard =
    admin && config.clerkSecretKey
      ? {
          admin,
          auth: new ClerkAuthProvider({
            secretKey: config.clerkSecretKey,
            authorizedParties: [config.dashboardOrigin],
            jwtKey: config.clerkJwtKey,
          }),
          boss,
          voice: retell,
          telephony: telephony?.provider,
          // Buying numbers from the admin screen: it still refuses unless
          // TWILIO_PURCHASES_ENABLED is true, as the live-* scripts do.
          numbers:
            config.twilio && config.publicBaseUrl && config.fallbackVoicemailUrl
              ? {
                  telephony: telephony?.provider ?? new TwilioTelephonyProvider(config.twilio),
                  publicBaseUrl: config.publicBaseUrl,
                  fallbackVoicemailUrl: config.fallbackVoicemailUrl,
                  purchasesEnabled: config.twilio.purchasesEnabled,
                  ukRegulatoryReady:
                    config.twilio.bundleSid !== undefined && config.twilio.addressSid !== undefined,
                }
              : undefined,
          billing: payments ? { payments, dashboardOrigin: config.dashboardOrigin } : undefined,
        }
      : undefined;
  if (dashboard) logger.info("Dashboard API on", { dashboardOrigin: config.dashboardOrigin });
  else logger.warn("Dashboard API disabled: needs CLERK_SECRET_KEY and ADMIN_DATABASE_URL");

  return createApp({
    pool,
    dashboardDist: config.dashboardDist,
    moveDashboard: config.alternateBaseUrl
      ? { fromHost: new URL(config.alternateBaseUrl).host, toOrigin: config.dashboardOrigin }
      : undefined,
    voiceProviders,
    telephony,
    dashboard,
    postmark: config.postmarkWebhookSecret
      ? { webhookSecret: config.postmarkWebhookSecret }
      : undefined,
    payments: payments
      ? {
          provider: payments,
          enqueueOnboarding: enqueueOnboardingWith(boss),
          enqueueBillingEmail: enqueueBillingEmailWith(boss),
        }
      : undefined,
    callPages: config.signingSecret
      ? {
          signingSecret: config.signingSecret,
          telephony: telephony?.provider,
          voice: retell,
          dashboardOrigin: config.dashboardOrigin,
        }
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
}
