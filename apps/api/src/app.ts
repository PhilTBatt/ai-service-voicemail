import express, { type ErrorRequestHandler } from "express";
import type pg from "pg";
import type { AlertFn } from "./alerts.ts";
import type { OutboundPolicy } from "./core/outbound-allowlist.ts";
import { lastHeartbeat, workerState } from "./db/worker-heartbeat.ts";
import type { EnqueueNotifications } from "./jobs/enqueue-notifications.ts";
import type { EnqueueOnboarding } from "./jobs/onboarding.ts";
import { logger } from "./logger.ts";
import type { TelephonyProvider } from "./providers/telephony.ts";
import type { CallEndedEvent, FunctionCallEvent, VoiceProvider } from "./providers/voice.ts";
import { callPageRouter } from "./routes/calls.ts";
import { dashboardRouter, type DashboardOptions } from "./routes/dashboard.ts";
import { postmarkRouter } from "./routes/postmark.ts";
import { signupRouter } from "./routes/signup.ts";
import { twilioRouter } from "./routes/twilio.ts";
import { voiceWebhookRouter } from "./routes/webhooks.ts";

export interface AppOptions {
  pool: pg.Pool;
  /** The logged-in dashboard API (/api). Absent until a login provider is configured (decision 012). */
  dashboard?: Omit<DashboardOptions, "pool"> | undefined;
  /** Postmark's bounce and complaint webhook. Absent until POSTMARK_WEBHOOK_SECRET is configured. */
  postmark?: { webhookSecret: string; alert?: AlertFn } | undefined;
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
  /** A mid-call emergency function fired (Step 6). */
  onFunctionCall?: (event: FunctionCallEvent) => Promise<unknown>;
  /** Call routing. Absent until Twilio and PUBLIC_BASE_URL are configured. */
  telephony?:
    | {
        provider: TelephonyProvider;
        voice: VoiceProvider;
        publicBaseUrl: string;
        outbound: OutboundPolicy;
        enqueueSync: (job: { tenantId: string; profileVersion: number }) => Promise<unknown>;
        enqueueNotifications: EnqueueNotifications;
        enqueueOnboarding?: EnqueueOnboarding;
        alert?: AlertFn;
        now?: () => Date;
        /** How long the voice platform gets to take a call, and routing to answer at all. */
        registerTimeoutMs?: number;
        deadlineMs?: number;
      }
    | undefined;
}

export function createApp({
  pool,
  voiceProviders = {},
  onCallEnded = () => Promise.resolve(),
  onFunctionCall,
  telephony,
  callPages,
  postmark,
  dashboard,
}: AppOptions) {
  const app = express();
  app.disable("x-powered-by");

  // Liveness: answers whenever the process can. It deliberately checks nothing else, so a
  // database outage never makes Azure restart containers that are otherwise healthy.
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  // The worker's check-in, for an availability alert (Step 8): 503 once it has missed four.
  // The API can be fine while the worker is down, so this stays out of /healthz and /readyz,
  // which decide whether Azure restarts or routes to this API instance.
  app.get("/healthz/worker", async (_req, res) => {
    try {
      const worker = workerState(await lastHeartbeat(pool), new Date());
      res.status(worker.state === "running" ? 200 : 503).json({
        status: worker.state,
        lastSeen: worker.state === "never" ? null : worker.seenAt.toISOString(),
      });
    } catch (error) {
      logger.warn("Worker check-in lookup failed", { error });
      res.status(503).json({ status: "unknown", lastSeen: null });
    }
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

  app.use(
    "/webhooks",
    voiceWebhookRouter({
      providers: voiceProviders,
      onCallEnded,
      ...(onFunctionCall && { onFunctionCall }),
    }),
  );
  if (telephony) {
    app.use(
      "/webhooks/twilio",
      twilioRouter({ pool, telephony: telephony.provider, ...telephony }),
    );
  }

  if (postmark) app.use("/webhooks/postmark", postmarkRouter({ pool, ...postmark }));
  if (callPages) app.use("/c", callPageRouter({ pool, ...callPages }));
  if (dashboard) {
    // First: following a signup link needs a login but no account, so it can't sit behind the
    // dashboard's account check.
    app.use(
      "/api/signup",
      signupRouter({
        admin: dashboard.admin,
        auth: dashboard.auth,
        ...(dashboard.now && { now: dashboard.now }),
      }),
    );
    app.use("/api", dashboardRouter({ pool, ...dashboard }));
  }

  // Last: Express's own handler prints the stack with console.error, unredacted, and shows
  // it to the client outside production. Log through the redacting logger instead, and
  // give the client nothing.
  const onError: ErrorRequestHandler = (error: unknown, req, res, _next) => {
    // Express's body parser marks what it refuses (malformed JSON, too large) with a 4xx
    // status and a type: that's a bad request, not a fault here.
    const { status, type } = (error ?? {}) as { status?: unknown; type?: unknown };
    if (typeof status === "number" && status >= 400 && status < 500 && typeof type === "string") {
      logger.warn("Refused a request body", { method: req.method, path: req.path, type });
      res.status(status).json({ error: "Bad request" });
      return;
    }
    logger.error("Unhandled request error", { error, method: req.method, path: req.path });
    res.status(500).json({ error: "Internal server error" });
  };
  app.use(onError);

  return app;
}
