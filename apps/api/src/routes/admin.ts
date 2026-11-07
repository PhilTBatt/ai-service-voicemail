// The admin API (BUILD_PLAN Step 10): Phil's view of the whole service. Mounted under
// /api/admin behind authenticate() and requireRole("admin"), so nothing here is reachable by
// an owner or the reseller. Cross-tenant reads go through the admin pool, as decision 006 says.
import type {
  AvailableNumbersView,
  CostsView,
  HealthView,
  KillSwitchView,
  OnboardingView,
  ProvisionedNumberView,
  ReviewQueueView,
  UsageView,
} from "@callmate/shared";
import { ONBOARDING_STATES } from "@callmate/shared";
import { Router } from "express";
import type pg from "pg";
import { z } from "zod";
import { buyNumberForTenant, searchNumbers } from "../admin/test-number.ts";
import type { AlertFn } from "../alerts.ts";
import { CURRENT_PRICES, describePrices, poundsToPence } from "../core/prices.ts";
import { startOfUkDate, usagePeriodFor } from "../core/usage.ts";
import {
  activeNumberFor,
  auditAdminAction,
  estimateCosts,
  healthSnapshot,
  listCurrentUsage,
  listFlaggedCalls,
  setKillSwitch,
  type AdminPool,
} from "../db/cross-tenant.ts";
import { advanceOnboarding, onboardingStatus, setPilot } from "../db/onboarding.ts";
import { countDeadLettered } from "../jobs/queue.ts";
import { PurchaseNotAllowedError, type TelephonyProvider } from "../providers/telephony.ts";
import { presentCallSummary } from "./call-view.ts";
import { principalOf, requireRole } from "./dashboard-auth.ts";

/** What buying a number needs: the provider, and where the number should send its calls. */
export interface NumberProvisioning {
  telephony: TelephonyProvider;
  publicBaseUrl: string;
  /** The TwiML Bin that plays the static voicemail when the API can't be reached. */
  fallbackVoicemailUrl: string;
  /** TWILIO_PURCHASES_ENABLED. Off, the admin screen can search for numbers but not buy one. */
  purchasesEnabled: boolean;
  alert?: AlertFn;
}

export interface AdminOptions {
  pool: pg.Pool;
  admin: AdminPool;
  /** Absent until Twilio, PUBLIC_BASE_URL and FALLBACK_VOICEMAIL_URL are configured. */
  numbers?: NumberProvisioning | undefined;
  now?: () => Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const switchBody = z.object({ on: z.boolean() });
const advanceBody = z.object({ to: z.enum(ONBOARDING_STATES) });
const pilotBody = z.object({ pilot: z.boolean() });
const isTenantId = (value: unknown): value is string => z.uuid().safeParse(value).success;
const reviewQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const numberSearchQuery = z.object({
  /** Digits the number should contain, such as an area code: "0113". */
  contains: z
    .string()
    .regex(/^\d{0,10}$/, "digits only")
    .default(""),
});
const buyNumberBody = z.object({
  number: z.string().regex(/^\+44\d{9,10}$/, "must be a UK number like +441134960100"),
  /** Buying costs money every month: the page sends this only after a confirmation dialog. */
  confirm: z.literal(true),
});

export function adminRouter({ pool, admin, numbers, now = () => new Date() }: AdminOptions) {
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

  // UK local numbers that could be bought now, and what one costs a month. Searching is free.
  router.get("/numbers/available", async (req, res) => {
    if (!numbers) {
      res.status(503).json({ error: "Twilio isn't set up on this server" });
      return;
    }
    const query = numberSearchQuery.safeParse(req.query);
    if (!query.success) {
      res
        .status(400)
        .json({ error: "Invalid search", issues: z.flattenError(query.error).fieldErrors });
      return;
    }
    const contains = query.data.contains === "" ? undefined : query.data.contains;
    const [found, prices] = await Promise.all([
      searchNumbers(numbers.telephony, contains),
      numbers.telephony.numberPrices(),
    ]);
    const local = prices.find((price) => price.type === "local");
    res.json({
      numbers: found,
      monthlyPence: local?.currency === "GBP" ? poundsToPence(local.monthly) : null,
      purchasesEnabled: numbers.purchasesEnabled,
    } satisfies AvailableNumbersView);
  });

  // Buys a number for a business that has none: a live action that costs money every month.
  // Three guards: the admin role, the confirmation the page sends after its dialog, and
  // TWILIO_PURCHASES_ENABLED on the server. A business never gets a second number this way:
  // the old one would carry on costing money at Twilio.
  router.post("/tenants/:tenantId/number", async (req, res) => {
    if (!numbers) {
      res.status(503).json({ error: "Twilio isn't set up on this server" });
      return;
    }
    const body = buyNumberBody.safeParse(req.body);
    if (!body.success) {
      res
        .status(400)
        .json({ error: "Invalid body", issues: z.flattenError(body.error).fieldErrors });
      return;
    }
    if (!numbers.purchasesEnabled) {
      res.status(409).json({
        error: "Buying numbers is switched off on this server (TWILIO_PURCHASES_ENABLED)",
      });
      return;
    }
    const { tenantId } = req.params;
    const exists =
      z.uuid().safeParse(tenantId).success &&
      (await admin.query("SELECT 1 FROM tenants WHERE id = $1", [tenantId])).rowCount === 1;
    if (!exists) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const current = await activeNumberFor(admin, tenantId);
    if (current) {
      res.status(409).json({ error: `This business already has ${current.number}` });
      return;
    }
    try {
      const bought = await buyNumberForTenant(
        { ...numbers, admin },
        { tenantId, number: body.data.number, confirm: true },
      );
      await auditAdminAction(admin, {
        tenantId,
        actorUserId: principalOf(res).userId,
        action: "number.provisioned",
        details: { via: "dashboard", number: bought.number, providerSid: bought.providerSid },
      });
      res.json({
        number: bought.number,
        providerSid: bought.providerSid,
      } satisfies ProvisionedNumberView);
    } catch (error) {
      if (error instanceof PurchaseNotAllowedError) {
        res.status(409).json({ error: "Twilio refused: purchases aren't enabled" });
        return;
      }
      throw error;
    }
  });

  // One business's onboarding checklist (BUILD_PLAN Step 11).
  router.get("/tenants/:tenantId/onboarding", async (req, res) => {
    const { tenantId } = req.params;
    const view = isTenantId(tenantId) ? await onboardingStatus(pool, tenantId) : null;
    if (!view) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(view satisfies OnboardingView);
  });

  // Moves a business on one step, if the rules allow it now. Answers with the new checklist,
  // or 409 and the reason in words.
  router.post("/tenants/:tenantId/onboarding/advance", async (req, res) => {
    const body = advanceBody.safeParse(req.body);
    if (!body.success) {
      res
        .status(400)
        .json({ error: "Invalid body", issues: z.flattenError(body.error).fieldErrors });
      return;
    }
    const { tenantId } = req.params;
    const result = isTenantId(tenantId)
      ? await advanceOnboarding(pool, tenantId, body.data.to, principalOf(res).userId)
      : ({ outcome: "not-found" } as const);
    if (result.outcome === "not-found") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (result.outcome === "refused") {
      res.status(409).json({ error: result.reason });
      return;
    }
    res.json((await onboardingStatus(pool, tenantId)) satisfies OnboardingView | null);
  });

  // A free pilot can pass "payment set up" before billing exists (Step 12).
  router.put("/tenants/:tenantId/pilot", async (req, res) => {
    const body = pilotBody.safeParse(req.body);
    if (!body.success) {
      res
        .status(400)
        .json({ error: "Invalid body", issues: z.flattenError(body.error).fieldErrors });
      return;
    }
    const { tenantId } = req.params;
    const found =
      isTenantId(tenantId) &&
      (await setPilot(pool, tenantId, body.data.pilot, principalOf(res).userId));
    if (!found) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json((await onboardingStatus(pool, tenantId)) satisfies OnboardingView | null);
  });

  return router;
}
