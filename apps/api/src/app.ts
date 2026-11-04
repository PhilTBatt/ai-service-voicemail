import express from "express";
import type pg from "pg";
import { logger } from "./logger.ts";

export function createApp({ pool }: { pool: pg.Pool }) {
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

  return app;
}
