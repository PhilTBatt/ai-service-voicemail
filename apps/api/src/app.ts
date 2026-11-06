import express, { type ErrorRequestHandler } from "express";
import type pg from "pg";
import { logger } from "./logger.ts";
import type { CallEndedEvent, VoiceProvider } from "./providers/voice.ts";
import { voiceWebhookRouter } from "./routes/webhooks.ts";

export interface AppOptions {
  pool: pg.Pool;
  voiceProviders?: Record<string, VoiceProvider>;
  onCallEnded?: (event: CallEndedEvent) => Promise<void>;
}

export function createApp({
  pool,
  voiceProviders = {},
  onCallEnded = () => Promise.resolve(),
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
