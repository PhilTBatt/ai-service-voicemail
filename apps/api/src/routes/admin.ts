// The admin API (BUILD_PLAN Step 10): Phil's view of the whole service. Mounted under
// /api/admin behind authenticate() and requireRole("admin"), so nothing here is reachable by
// an owner or the reseller. Cross-tenant reads go through the admin pool, as decision 006 says.
import type {
  CostsView,
  HealthView,
  KillSwitchView,
  ReviewQueueView,
  UsageView,
} from "@callmate/shared";
import { Router } from "express";
import type pg from "pg";
import { z } from "zod";
import { CURRENT_PRICES, describePrices } from "../core/prices.ts";
import { startOfUkDate, usagePeriodFor } from "../core/usage.ts";
import {
  estimateCosts,
  healthSnapshot,
  listCurrentUsage,
  listFlaggedCalls,
  setKillSwitch,
  type AdminPool,
} from "../db/cross-tenant.ts";
import { countDeadLettered } from "../jobs/queue.ts";
import { presentCallSummary } from "./call-view.ts";
import { principalOf, requireRole } from "./dashboard-auth.ts";

export interface AdminOptions {
  pool: pg.Pool;
  admin: AdminPool;
  now?: () => Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const switchBody = z.object({ on: z.boolean() });
const reviewQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function adminRouter({ pool, admin, now = () => new Date() }: AdminOptions) {
  const router = Router();
  router.use(requireRole("admin"));

  // One screen: is the service healthy right now? Counts over the last 24 hours, and the
  // syncs that are currently failing.
  router.get("/health", async (_req, res) => {
    const since = new Date(now().getTime() - DAY_MS);
    const [snapshot, deadLettered] = await Promise.all([
      healthSnapshot(admin, since),
      countDeadLettered(pool, since),
    ]);
    res.json({ ...snapshot, deadLetteredJobs24h: deadLettered } satisfies HealthView);
  });

  // The kill switch: on sends every caller on every number to the fallback voicemail.
  router.put("/kill-switch", async (req, res) => {
    const body = switchBody.safeParse(req.body);
    if (!body.success) {
      res
        .status(400)
        .json({ error: "Invalid body", issues: z.flattenError(body.error).fieldErrors });
      return;
    }
    await setKillSwitch(admin, body.data.on, principalOf(res).userId);
    res.json({ killSwitchOn: body.data.on } satisfies KillSwitchView);
  });

  // Calls the pipeline flagged (price mentions, guardrail hits, judge failures), newest first.
  router.get("/review-queue", async (req, res) => {
    const query = reviewQuery.safeParse(req.query);
    if (!query.success) {
      res
        .status(400)
        .json({ error: "Invalid query", issues: z.flattenError(query.error).fieldErrors });
      return;
    }
    const flagged = await listFlaggedCalls(admin, query.data.limit);
    res.json({
      calls: flagged.map(({ tenant, ...call }) => ({ ...presentCallSummary(call), tenant })),
    } satisfies ReviewQueueView);
  });

  // Billable seconds per tenant for the period that contains today. Prices come with Step 12.
  router.get("/usage", async (_req, res) => {
    res.json({ tenants: await listCurrentUsage(admin, now()) } satisfies UsageView);
  });

  // What each business cost us this month, estimated from the recorded costs and the price list.
  router.get("/costs", async (_req, res) => {
    const { periodStart, periodEnd } = usagePeriodFor(now());
    const { tenants, unpriced } = await estimateCosts(
      admin,
      { from: startOfUkDate(periodStart), to: startOfUkDate(periodEnd) },
      CURRENT_PRICES,
    );
    res.json({
      periodStart,
      periodEnd,
      tenants,
      assumptions: describePrices(CURRENT_PRICES),
      unpriced,
    } satisfies CostsView);
  });

  return router;
}
