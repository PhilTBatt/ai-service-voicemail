import express, { type ErrorRequestHandler } from "express";
import type pg from "pg";
import type { OutboundPolicy } from "./core/outbound-allowlist.ts";
import type { EnqueueNotifications } from "./jobs/enqueue-notifications.ts";
import { logger } from "./logger.ts";
import type { TelephonyProvider } from "./providers/telephony.ts";
import type { CallEndedEvent, VoiceProvider } from "./providers/voice.ts";
import { callPageRouter } from "./routes/calls.ts";
import { twilioRouter } from "./routes/twilio.ts";
import { voiceWebhookRouter } from "./routes/webhooks.ts";

export interface AppOptions {
  pool: pg.Pool;
  /** The signed call pages (/c/:token). Absent until SIGNING_SECRET is configured. */
  callPages?:
    | {
        signingSecret: string;
        telephony?: TelephonyProvider | undefined;
        voice?: VoiceProvider | undefined;
        now?: () => Date;
      }
    | undefined;
  voiceProviders?: Record<string, VoiceProvider>;
  onCallEnded?: (event: CallEndedEvent) => Promise<void>;
  /** Call routing. Absent until Twilio and PUBLIC_BASE_URL are configured. */
  telephony?:
    | {
        provider: TelephonyProvider;
        voice: VoiceProvider;
        publicBaseUrl: string;
        outbound: OutboundPolicy;
        enqueueSync: (job: { tenantId: string; profileVersion: number }) => Promise<unknown>;
        enqueueNotifications: EnqueueNotifications;
        now?: () => Date;
      }
    | undefined;
}

export function createApp({
  pool,
  voiceProviders = {},
  onCallEnded = () => Promise.resolve(),
  telephony,
  callPages,
}: AppOptions) {
  const app = express();
  app.disable("x-powered-by");

  // Liveness: answers whenever the process can. It deliberately checks nothing else, so a
  // database outage never makes Azure restart containers that are otherwise healthy.
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Readiness: can this instance do useful work? A 503 tells the load balancer to stop
  // sending traffic here until the database is reachable again.
  app.get("/readyz", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ status: "ready" });
    } catch (error) {
      logger.warn("Readiness check failed", { error });
      res.status(503).json({ status: "unavailable" });
    }
  });

  app.use("/webhooks", voiceWebhookRouter({ providers: voiceProviders, onCallEnded }));
  if (telephony) {
    app.use(
      "/webhooks/twilio",
      twilioRouter({ pool, telephony: telephony.provider, ...telephony }),
    );
  }

  if (callPages) app.use("/c", callPageRouter({ pool, ...callPages }));

  // Last: Express's own handler prints the stack with console.error, unredacted, and shows
  // it to the client outside production. Log through the redacting logger instead, and
  // give the client nothing.
  const onError: ErrorRequestHandler = (error: unknown, req, res, _next) => {
    logger.error("Unhandled request error", { error, method: req.method, path: req.path });
    res.status(500).json({ error: "Internal server error" });
  };
  app.use(onError);

  return app;
}
