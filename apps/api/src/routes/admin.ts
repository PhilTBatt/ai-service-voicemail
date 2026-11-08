// The admin API (BUILD_PLAN Step 10): Phil's view of the whole service. Mounted under
// /api/admin behind authenticate() and requireRole("admin"), so nothing here is reachable by
// an owner or the reseller. Cross-tenant reads go through the admin pool, as decision 006 says.
import type {
  AvailableNumbersView,
  CallReviewedView,
  CancellationsView,
  CostsView,
  DataDeletionView,
  HealthView,
  KillSwitchView,
  OnboardingView,
  ProvisionedNumberView,
  ReleasedNumberView,
  ReviewQueueView,
  UsageView,
} from "@callmate/shared";
import { ONBOARDING_STATES } from "@callmate/shared";
import { Router } from "express";
import type pg from "pg";
import { z } from "zod";
import { buyNumberForTenant, searchNumbers } from "../admin/test-number.ts";
import type { AlertFn } from "../alerts.ts";
import { releaseDueAt } from "../core/offboarding.ts";
import { CURRENT_PRICES, describePrices, poundsToPence } from "../core/prices.ts";
import { startOfUkDate, usagePeriodFor } from "../core/usage.ts";
import {
  activeNumberFor,
  auditAdminAction,
  tenantExists,
  withAdvisoryLock,
  estimateCosts,
  healthSnapshot,
  listCurrentUsage,
  listCancellingTenants,
  listFlaggedCalls,
  markCallReviewed,
  recordNumberReleased,
  setKillSwitch,
  type AdminPool,
} from "../db/cross-tenant.ts";
import { advanceOnboarding, onboardingStatus, setPilot } from "../db/onboarding.ts";
import { ukDateTime } from "../core/uk-time.ts";
import { withTenant } from "../db/tenant.ts";
import type { EnqueueOffboarding } from "../jobs/offboarding.ts";
import type { EnqueueOnboarding } from "../jobs/onboarding.ts";
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
  /** Onboarding texts and going live (BUILD_PLAN Step 11). */
  enqueueOnboarding?: EnqueueOnboarding | undefined;
  /** Deleting a business's data (BUILD_PLAN Step 13). */
  enqueueOffboarding?: EnqueueOffboarding | undefined;
  now?: () => Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const switchBody = z.object({ on: z.boolean() });
const advanceBody = z.object({ to: z.enum(ONBOARDING_STATES) });
const pilotBody = z.object({ pilot: z.boolean() });
/** Deleting a business's data can't be undone: the page asks for its name to be typed. */
const deleteDataBody = z.object({ confirm: z.literal(true), businessName: z.string() });
/** Releasing a number can't be undone: the page sends this only after a confirmation dialog. */
const releaseBody = z.object({ confirm: z.literal(true) });
const isTenantId = (value: unknown): value is string => z.uuid().safeParse(value).success;
/** The review queue's page cursor: "<started at, ISO>|<call id>", as nextBefore gave it. */
const reviewCursor = z.string().transform((value, ctx) => {
  const parts = value.split("|");
  const at = z.iso.datetime({ offset: true }).safeParse(parts[0]);
  const id = z.uuid().safeParse(parts[1]);
  if (parts.length !== 2 || !at.success || !id.success) {
    ctx.addIssue({ code: "custom", message: "not a cursor from this list" });
    return z.NEVER;
  }
  return { startedAt: at.data, id: id.data };
});
const reviewQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: reviewCursor.optional(),
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

export function adminRouter({
  pool,
  admin,
  numbers,
  enqueueOnboarding,
  enqueueOffboarding,
  now = () => new Date(),
}: AdminOptions) {
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

  // Calls the pipeline flagged for a person to check (a price, a time or safety advice in the
  // agent's words, a summary the judge doubted, a summary that failed), not yet reviewed, newest
  // first, a page at a time.
  router.get("/review-queue", async (req, res) => {
    const query = reviewQuery.safeParse(req.query);
    if (!query.success) {
      res
        .status(400)
        .json({ error: "Invalid query", issues: z.flattenError(query.error).fieldErrors });
      return;
    }
    const { calls, next } = await listFlaggedCalls(admin, {
      limit: query.data.limit,
      after: query.data.before,
    });
    res.json({
      calls: calls.map(({ tenant, ...call }) => ({ ...presentCallSummary(call), tenant })),
      nextBefore: next ? `${next.startedAt}|${next.id}` : null,
    } satisfies ReviewQueueView);
  });

  // Takes a call out of the queue once it's been looked at. Marking it twice is harmless.
  router.post("/calls/:callId/reviewed", async (req, res) => {
    const { callId } = req.params;
    if (!z.uuid().safeParse(callId).success) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const marked = await markCallReviewed(admin, callId, principalOf(res).userId);
    if (!marked) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ callId, reviewedAt: marked.reviewedAt.toISOString() } satisfies CallReviewedView);
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
    if (!(await tenantExists(admin, tenantId))) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    // One purchase at a time for a business. Two at once (two tabs, say) would both find no
    // number and both buy one, and the second would mark the first released here while
    // Twilio went on charging for it.
    const run = await withAdvisoryLock(admin, `buy-number:${tenantId}`, async () => {
      const current = await activeNumberFor(admin, tenantId);
      if (current) {
        return { status: 409, body: { error: `This business already has ${current.number}` } };
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
        const view: ProvisionedNumberView = {
          number: bought.number,
          providerSid: bought.providerSid,
        };
        return { status: 200, body: view };
      } catch (error) {
        if (error instanceof PurchaseNotAllowedError) {
          return { status: 409, body: { error: "Twilio refused: purchases aren't enabled" } };
        }
        throw error;
      }
    });
    if (!run.held) {
      res.status(409).json({ error: "A number is already being bought for this business" });
      return;
    }
    res.status(run.result.status).json(run.result.body);
  });

  // Businesses that are leaving (BUILD_PLAN Step 13): callers hear "service has ended" for 30
  // days, then the number can be released.
  router.get("/cancellations", async (_req, res) => {
    const current = now();
    const tenants = (await listCancellingTenants(admin)).map((tenant) => {
      const due = releaseDueAt(tenant.cancellationRequestedAt);
      return {
        tenantId: tenant.tenantId,
        businessName: tenant.businessName,
        status: tenant.status,
        cancellationRequestedAt: tenant.cancellationRequestedAt.toISOString(),
        releaseDueAt: due.toISOString(),
        number: tenant.number,
        due: due <= current,
      };
    });
    res.json({ tenants } satisfies CancellationsView);
  });

  // Releases a leaving business's number once its 30 days are up: a live action that can't be
  // undone (the number goes back to Twilio), behind the admin role and a confirmation. Releasing
  // is safe to repeat, so a failure part-way can simply be tried again.
  router.post("/tenants/:tenantId/release-number", async (req, res) => {
    const body = releaseBody.safeParse(req.body);
    if (!body.success) {
      res
        .status(400)
        .json({ error: "Invalid body", issues: z.flattenError(body.error).fieldErrors });
      return;
    }
    const { tenantId } = req.params;
    const tenant = isTenantId(tenantId)
      ? (await listCancellingTenants(admin)).find((row) => row.tenantId === tenantId)
      : undefined;
    if (tenant?.status !== "cancelling") {
      res.status(409).json({ error: "Only a business that's cancelling has a number to release" });
      return;
    }
    const due = releaseDueAt(tenant.cancellationRequestedAt);
    if (due > now()) {
      res.status(409).json({
        error: `Callers hear "service has ended" until ${ukDateTime(due)} UK time; release it after that`,
      });
      return;
    }
    if (tenant.providerSid) {
      if (!numbers) {
        res.status(503).json({ error: "Twilio isn't set up on this server" });
        return;
      }
      await numbers.telephony.releaseNumber(tenant.providerSid);
    }
    await recordNumberReleased(admin, tenantId, principalOf(res).userId);
    res.json({ released: tenant.number, status: "cancelled" } satisfies ReleasedNumberView);
  });

  // Deletes a business's data under the DPA (BUILD_PLAN Step 13): at the providers and here,
  // with a written confirmation. Only once it has left (number released), and only after its
  // name is typed, because nothing brings the data back. The worker does the deleting.
  router.post("/tenants/:tenantId/delete-data", async (req, res) => {
    const body = deleteDataBody.safeParse(req.body);
    if (!body.success) {
      res
        .status(400)
        .json({ error: "Invalid body", issues: z.flattenError(body.error).fieldErrors });
      return;
    }
    const { tenantId } = req.params;
    const tenant = isTenantId(tenantId)
      ? (await listCancellingTenants(admin)).find((row) => row.tenantId === tenantId)
      : undefined;
    if (tenant?.status !== "cancelled") {
      res.status(409).json({
        error:
          "Only a business that has cancelled and had its number released can have its data deleted",
      });
      return;
    }
    if (body.data.businessName.trim().toLowerCase() !== tenant.businessName.trim().toLowerCase()) {
      res.status(409).json({ error: "That isn't the business's name" });
      return;
    }
    if (!enqueueOffboarding) {
      res.status(503).json({ error: "The job queue isn't available" });
      return;
    }
    const actorUserId = principalOf(res).userId;
    await enqueueOffboarding({ tenantId, action: "delete-data", actorUserId });
    await auditAdminAction(admin, {
      tenantId,
      actorUserId,
      action: "tenant.deletion-requested",
      details: { via: "dashboard" },
    });
    res.status(202).json({ queued: true } satisfies DataDeletionView);
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
    // Live by hand: the go-live text still goes out (the job sends it once, ever).
    if (result.state === "live") await enqueueOnboarding?.({ tenantId, action: "go-live" });
    res.json((await onboardingStatus(pool, tenantId)) satisfies OnboardingView | null);
  });

  // Texts the divert instructions for the business's network. The worker sends the text and
  // moves the business on from "assistant set up" once it's gone. Sending again is fine.
  router.post("/tenants/:tenantId/onboarding/divert-instructions", async (req, res) => {
    const { tenantId } = req.params;
    const ready = isTenantId(tenantId)
      ? await withTenant(
          pool,
          tenantId,
          async (client) =>
            (
              await client.query<{ has_number: boolean; has_mobile: boolean }>(
                `SELECT EXISTS (SELECT 1 FROM phone_numbers n
                                WHERE n.tenant_id = t.id AND n.status = 'active') AS has_number,
                        t.notification_mobile IS NOT NULL AS has_mobile
                 FROM tenants t WHERE t.id = $1`,
                [tenantId],
              )
            ).rows[0],
        )
      : undefined;
    if (!ready) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (!ready.has_number || !ready.has_mobile) {
      res.status(409).json({
        error: "The business needs an AnswerMate number and a mobile for texts first",
      });
      return;
    }
    if (!enqueueOnboarding) {
      res.status(503).json({ error: "The job queue isn't available" });
      return;
    }
    await enqueueOnboarding({ tenantId, action: "send-divert-instructions" });
    await auditAdminAction(admin, {
      tenantId,
      actorUserId: principalOf(res).userId,
      action: "divert-instructions.requested",
      details: { via: "dashboard" },
    });
    res.status(202).json({ queued: true });
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
