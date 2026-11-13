// The dashboard's API (BUILD_PLAN Step 10): what the React app calls once a person is logged
// in: who am I, the tenants I can see, a tenant's calls, its agent profile, the on/off switch,
// notification settings, the data export and the cancellation request.
//
// Tenant data is read inside withTenant(), so row-level security backs up the middleware:
// even a bug in requireTenantAccess() couldn't hand one tenant's calls to another. The
// cross-tenant list (admin and reseller) uses the admin pool, as the admin screens are meant to.
import {
  CSV_EXPORTS,
  URGENCIES,
  acceptDocumentsSchema,
  confirmMobileSchema,
  documentsToAccept,
  type BillingView,
  type ConfirmMobileView,
  type NotificationSettingsView,
  type DirectDebitStartView,
  type DocumentsView,
  type CallHandledView,
  type CallListView,
  type AgentProfileInput,
  type CreatedSignupLinkView,
  type CancellationView,
  type MeView,
  type MobileNetwork,
  type ProfileView,
  type SaveProfileView,
  type SwitchView,
  type TenantListItem,
  type TenantListView,
  type TenantView,
} from "@callmate/shared";
import { Router, json } from "express";
import type { PgBoss } from "pg-boss";
import type pg from "pg";
import { z } from "zod";
import { releaseDueAt } from "../core/offboarding.ts";
import { agentProfileInputSchema, saveAgentProfile } from "../db/agent-profiles.ts";
import { NEEDS_REPLY_SQL, setCallHandled } from "../db/call-handled.ts";
import { enqueueOffboardingWith } from "../jobs/offboarding.ts";
import { enqueueOnboardingWith } from "../jobs/onboarding.ts";
import { adminRouter, type NumberProvisioning } from "./admin.ts";
import {
  createSignupLink,
  listTenantsWithCallCounts,
  type AdminPool,
  type TenantWithCallCounts,
} from "../db/cross-tenant.ts";
import {
  acceptDocuments,
  latestAcceptances,
  presentDocuments,
  versionsOf,
} from "../db/documents.ts";
import { listOwnTenants } from "../db/own-tenants.ts";
import { withTenant } from "../db/tenant.ts";
import {
  exportTenant,
  exportTenantCsv,
  notificationSettingsSchema,
  requestCancellation,
  updateNotificationSettings,
} from "../db/tenant-settings.ts";
import { switchAnswering } from "../db/tenant-switch.ts";
import { mobileCodeSms } from "../core/mobile-confirmation.ts";
import { checkOutbound, type OutboundPolicy } from "../core/outbound-allowlist.ts";
import {
  confirmMobile,
  pendingMobile,
  startMobileConfirmation,
} from "../db/mobile-confirmations.ts";
import { logger } from "../logger.ts";
import type { SmsProvider } from "../providers/sms.ts";
import { loadBillingView } from "../db/billing.ts";
import { checkDirectDebit, startDirectDebit } from "../db/direct-debit.ts";
import type { AuthProvider } from "../providers/auth.ts";
import type { PaymentsProvider } from "../providers/payments.ts";
import {
  CALL_VIEW_COLUMNS,
  presentCall,
  presentCallSummary,
  streamRecording,
  type CallRow,
  type RecordingSources,
} from "./call-view.ts";
import {
  authenticate,
  principalOf,
  requireRole,
  requireTenantAccess,
  tenantIdOf,
} from "./dashboard-auth.ts";

export interface DashboardOptions extends RecordingSources {
  pool: pg.Pool;
  admin: AdminPool;
  auth: AuthProvider;
  /** Profile saves queue their agent sync through here. */
  boss: PgBoss;
  /** Buying numbers from the admin screens. Absent until Twilio and the public URLs are set. */
  numbers?: NumberProvisioning | undefined;
  /**
   * Direct Debit (Step 12), and where the dashboard is, for the provider's page to send the
   * person back to. Absent until GoCardless is configured.
   */
  billing?: { payments: PaymentsProvider; dashboardOrigin: string } | undefined;
  /**
   * Texting a new notification mobile its confirmation code (PROGRESS open question 4), through
   * the outbound allowlist like every text. Absent when the server has no SMS settings: a new
   * mobile then can't be confirmed, and the page says so.
   */
  sms?: { provider: SmsProvider; outbound: OutboundPolicy } | undefined;
  /** The code to text, for the browser tests' server; random otherwise. */
  newMobileCode?: (() => string) | undefined;
  now?: () => Date;
}

export const CALL_LIST_DEFAULT_LIMIT = 50;
export const CALL_LIST_MAX_LIMIT = 200;

/** Filters for the call list. Dates are instants; the dashboard turns London days into them. */
const callListQuery = z.object({
  urgency: z.enum(URGENCIES).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  /** Keyset cursor: calls that started strictly before this instant (the last row's startedAt). */
  before: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(CALL_LIST_MAX_LIMIT).default(CALL_LIST_DEFAULT_LIMIT),
  /** Only the calls still waiting for a reply (db/call-handled.ts says which those are). */
  needsReply: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

const callHandledBody = z.object({ handled: z.boolean() });
const cancelBody = z.object({ confirm: z.literal(true) });

interface TenantRow {
  id: string;
  business_name: string;
  trade: string;
  status: string;
  contact_name: string | null;
  notification_mobile: string | null;
  notification_email: string | null;
  service_region: string;
  created_at: Date;
  number: string | null;
  mobile_network: MobileNetwork | null;
  cancellation_requested_at: Date | null;
}

interface ProfileRow {
  version: number;
  trade_template: string;
  services: string[];
  service_areas: string[];
  opening_hours: Record<string, unknown>;
  holiday_mode: boolean;
  holiday_until: string | null;
  faqs: unknown[];
  emergency_policy: Record<string, unknown>;
  synced_at: Date | null;
  sync_error: string | null;
}

const switchBody = z.object({ on: z.boolean() });
const csvExportQuery = z.object({ table: z.enum(CSV_EXPORTS) });
const signupLinkBody = z.object({ forTest: z.boolean().default(false) });

export function dashboardRouter({
  pool,
  admin,
  auth,
  boss,
  telephony,
  voice,
  numbers,
  billing,
  sms,
  newMobileCode,
  now,
}: DashboardOptions) {
  const router = Router();
  const sources: RecordingSources = { telephony, voice };
  const clock = now ?? (() => new Date());
  router.use(json({ limit: "256kb" }));

  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.use(authenticate(pool, auth));

  router.get("/me", (_req, res) => {
    const { userId, email, role, tenantIds } = principalOf(res);
    res.json({ userId, email, role, tenantIds } satisfies MeView);
  });

  // The tenant list. Admin and reseller see every tenant; an owner sees the ones they belong
  // to, each read inside its own row-level security (db/own-tenants.ts). The reseller's view
  // is this list and nothing below it: counts, never content.
  router.get("/tenants", requireRole("owner", "admin", "reseller"), async (_req, res) => {
    const principal = principalOf(res);
    const visible =
      principal.role === "owner"
        ? await listOwnTenants(pool, principal.tenantIds)
        : await listTenantsWithCallCounts(admin);
    res.json({ tenants: visible.map(presentTenantSummary) } satisfies TenantListView);
  });

  router.use(
    "/admin",
    adminRouter({
      pool,
      admin,
      numbers,
      enqueueOnboarding: enqueueOnboardingWith(boss),
      enqueueOffboarding: enqueueOffboardingWith(boss),
      payments: billing?.payments,
      ...(now && { now }),
    }),
  );

  // A single-use signup link for a new business (BUILD_PLAN Step 11): Phil or Ant hands it
  // to a tradesperson. Only the admin can make a test link, because a test business may go
  // live while the legal documents are placeholders.
  router.post("/signup-links", requireRole("admin", "reseller"), async (req, res) => {
    const body = signupLinkBody.safeParse(req.body ?? {});
    if (!body.success) {
      res
        .status(400)
        .json({ error: "Invalid body", issues: z.flattenError(body.error).fieldErrors });
      return;
    }
    const principal = principalOf(res);
    const forTest = principal.role === "admin" && body.data.forTest;
    const link = await createSignupLink(admin, {
      createdBy: principal.userId,
      forTest,
      now: now?.() ?? new Date(),
    });
    res.status(201).json({
      code: link.code,
      expiresAt: link.expiresAt.toISOString(),
      forTest,
    } satisfies CreatedSignupLinkView);
  });

  const tenant = Router({ mergeParams: true });
  router.use("/tenants/:tenantId", requireTenantAccess(), tenant);

  tenant.get("/", async (_req, res) => {
    const tenantId = tenantIdOf(res);
    const found = await withTenant(pool, tenantId, async (client) => {
      const row = (
        await client.query<TenantRow>(
          `SELECT id, business_name, trade, status, contact_name, notification_mobile,
                  notification_email, service_region, created_at, mobile_network,
                  cancellation_requested_at,
                  (SELECT number FROM phone_numbers
                   WHERE tenant_id = tenants.id AND status = 'active') AS number
           FROM tenants WHERE id = $1`,
          [tenantId],
        )
      ).rows[0];
      return (
        row && {
          row,
          accepted: await latestAcceptances(client, tenantId),
          pending: await pendingMobile(client, tenantId, clock()),
        }
      );
    });
    if (!found) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const { row, accepted, pending } = found;
    res.json({
      id: row.id,
      businessName: row.business_name,
      trade: row.trade,
      status: row.status,
      contactName: row.contact_name,
      notificationMobile: row.notification_mobile,
      pendingMobile: pending?.mobile ?? null,
      notificationEmail: row.notification_email,
      serviceRegion: row.service_region,
      createdAt: row.created_at.toISOString(),
      number: row.number,
      mobileNetwork: row.mobile_network,
      cancellationRequestedAt: row.cancellation_requested_at?.toISOString() ?? null,
      releaseDueAt: row.cancellation_requested_at
        ? releaseDueAt(row.cancellation_requested_at).toISOString()
        : null,
      documentsToAccept: documentsToAccept(versionsOf(accepted)),
    } satisfies TenantView);
  });

  // The legal documents, and where this business stands with each (BUILD_PLAN Step 11).
  tenant.get("/documents", async (_req, res) => {
    const tenantId = tenantIdOf(res);
    const accepted = await withTenant(pool, tenantId, (client) =>
      latestAcceptances(client, tenantId),
    );
    res.json({ documents: presentDocuments(accepted) } satisfies DocumentsView);
  });

  // The owner accepts the current versions. Only the owner: the business is the one agreeing,
  // so an admin can't accept for it. A version that has changed since the page loaded is
  // refused (409) rather than recorded as accepted.
  tenant.post("/documents/accept", requireRole("owner"), async (req, res) => {
    const body = acceptDocumentsSchema.safeParse(req.body);
    if (!body.success) {
      res
        .status(400)
        .json({ error: "Invalid body", issues: z.flattenError(body.error).fieldErrors });
      return;
    }
    const tenantId = tenantIdOf(res);
    const result = await acceptDocuments(
      pool,
      tenantId,
      principalOf(res).userId,
      body.data,
      enqueueOnboardingWith(boss),
    );
    if (result.outcome === "stale") {
      res.status(409).json({
        error:
          "These documents have changed since the page loaded: reload to read the current versions",
        stale: result.stale,
      });
      return;
    }
    res.json({ documents: presentDocuments(result.latest) } satisfies DocumentsView);
  });

  // The agent profile: what the tenant edits, plus how the sync of the latest version is
  // going ("live in about a minute", or the error). Null before the first save.
  tenant.get("/profile", async (_req, res) => {
    const isAdmin = principalOf(res).role === "admin";
    const tenantId = tenantIdOf(res);
    const row = await withTenant(
      pool,
      tenantId,
      async (client) =>
        (
          await client.query<ProfileRow>(
            `SELECT version, trade_template, services, service_areas, opening_hours, holiday_mode,
                    to_char(holiday_until, 'YYYY-MM-DD') AS holiday_until, faqs, emergency_policy,
                    synced_at, sync_error
             FROM agent_profiles WHERE tenant_id = $1 ORDER BY version DESC LIMIT 1`,
            [tenantId],
          )
        ).rows[0],
    );
    res.json(
      row
        ? presentProfile(row, isAdmin)
        : ({ profile: null, version: null, sync: null } satisfies ProfileView),
    );
  });

  tenant.put("/profile", async (req, res) => {
    const tenantId = tenantIdOf(res);
    const body = agentProfileInputSchema.safeParse(req.body);
    if (!body.success) {
      res
        .status(400)
        .json({ error: "Invalid profile", issues: z.flattenError(body.error).fieldErrors });
      return;
    }
    const version = await saveAgentProfile(pool, boss, tenantId, body.data, {
      userId: principalOf(res).userId,
    });
    res.json({
      version,
      sync: { state: "pending", syncedAt: null, error: null },
    } satisfies SaveProfileView);
  });

  // The on/off switch. Off sends every caller to the fallback voicemail; the same as texting OFF.
  tenant.put("/switch", async (req, res) => {
    const tenantId = tenantIdOf(res);
    const body = switchBody.safeParse(req.body);
    if (!body.success) {
      res
        .status(400)
        .json({ error: "Invalid body", issues: z.flattenError(body.error).fieldErrors });
      return;
    }
    const result = await switchAnswering(pool, tenantId, body.data.on, principalOf(res).userId);
    if (result.outcome === "not-allowed") {
      res.status(409).json({
        error: `AnswerMate can't be switched on or off while the account is ${result.status}`,
        status: result.status,
      });
      return;
    }
    res.json({ outcome: result.outcome, status: result.status } satisfies SwitchView);
  });

  // Where texts and emails go. Null clears a channel; the delivery jobs then skip it. A new
  // mobile is texted a code and takes effect once the code comes back (confirm-mobile below), so
  // a typo can't send the business's texts to a stranger; an admin's change is saved outright.
  tenant.put("/notifications", async (req, res) => {
    const tenantId = tenantIdOf(res);
    // `newCode`: the page's "Send a new code" (the first never arrived, say); otherwise saving the
    // same new mobile again leaves the code already out alone.
    const body = notificationSettingsSchema
      .extend({ newCode: z.boolean().optional() })
      .safeParse(req.body);
    if (!body.success) {
      res
        .status(400)
        .json({ error: "Invalid settings", issues: z.flattenError(body.error).fieldErrors });
      return;
    }
    const principal = principalOf(res);
    const saved = await updateNotificationSettings(pool, tenantId, body.data, principal.userId, {
      confirmMobile: principal.role !== "admin",
      now: clock(),
    });
    let mobileCode: NotificationSettingsView["mobileCode"] = null;
    let retryAt: string | null = null;
    // The same new mobile saved again (the form re-sent with a corrected email, say) while its code
    // is still out: that code stands. A new one would stop the one on the phone and use up one of
    // the hour's three.
    const alreadyOut =
      saved.mobileToConfirm !== null &&
      body.data.newCode !== true &&
      (await withTenant(pool, tenantId, (client) => pendingMobile(client, tenantId, clock())))
        ?.mobile === saved.mobileToConfirm;
    if (saved.mobileToConfirm !== null && !alreadyOut) {
      const started = await startMobileConfirmation(
        pool,
        tenantId,
        saved.mobileToConfirm,
        principal.userId,
        clock(),
        newMobileCode,
      );
      if (started.outcome === "too-many-codes") {
        mobileCode = "too-many-codes";
        retryAt = started.retryAt.toISOString();
      } else if (!sms) {
        mobileCode = "unavailable";
      } else {
        const decision = checkOutbound(sms.outbound, saved.mobileToConfirm);
        if (decision.allowed) {
          await sms.provider.send({
            to: saved.mobileToConfirm,
            body: mobileCodeSms(started.code).body,
          });
          mobileCode = "sent";
        } else {
          logger.warn("Mobile confirmation code blocked by the outbound allowlist", {
            tenantId,
            reason: decision.reason,
          });
          mobileCode = "blocked";
        }
      }
    }
    const pending = await withTenant(pool, tenantId, (client) =>
      pendingMobile(client, tenantId, clock()),
    );
    res.json({
      notificationMobile: saved.notificationMobile,
      notificationEmail: saved.notificationEmail,
      pendingMobile: pending?.mobile ?? null,
      mobileCode,
      retryAt,
    } satisfies NotificationSettingsView);
  });

  // The code texted to a new mobile, typed back: on a match the mobile is saved and texts go there.
  tenant.post("/notifications/confirm-mobile", async (req, res) => {
    const body = confirmMobileSchema.safeParse(req.body);
    if (!body.success) {
      res
        .status(400)
        .json({ error: "Invalid code", issues: z.flattenError(body.error).fieldErrors });
      return;
    }
    const result = await confirmMobile(
      pool,
      tenantIdOf(res),
      body.data.code,
      principalOf(res).userId,
      clock(),
    );
    res.json({
      outcome: result.outcome,
      notificationMobile: result.outcome === "confirmed" ? result.mobile : null,
      attemptsLeft: result.outcome === "wrong-code" ? result.attemptsLeft : null,
    } satisfies ConfirmMobileView);
  });

  // Asking to leave: callers hear "service has ended" from now on, and the notices are queued.
  // Leaving can't be done by a stray request: the body must confirm it, as the page's typed
  // CANCEL does (and as suspending does). Undoing it afterwards is an admin's job.
  tenant.post("/cancel", async (req, res) => {
    if (!cancelBody.safeParse(req.body).success) {
      res.status(400).json({ error: "Cancelling needs { confirm: true }" });
      return;
    }
    const tenantId = tenantIdOf(res);
    const result = await requestCancellation(pool, tenantId, principalOf(res).userId, {
      now: now?.() ?? new Date(),
      enqueueOffboarding: enqueueOffboardingWith(boss),
    });
    if (result.outcome === "not-allowed") {
      res.status(409).json({
        error: `The account is ${result.status}, so there's nothing to cancel from here`,
        status: result.status,
      });
      return;
    }
    res.json(result satisfies CancellationView);
  });

  // The plan, this billing month so far, and the Direct Debit (Step 12). The owner and the
  // admin: the reseller never reaches a tenant's own routes.
  tenant.get("/billing", async (_req, res) => {
    const view = await loadBillingView(pool, tenantIdOf(res), {
      now: now?.() ?? new Date(),
      available: billing !== undefined,
    });
    if (!view) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(view satisfies BillingView);
  });

  // Sends the person to the payments provider's page to set up Direct Debit. The answer is
  // where to go; the provider sends them back to the Account tab, which then checks.
  tenant.post("/billing/direct-debit", async (_req, res) => {
    if (!billing) {
      res.status(503).json({ error: "Direct Debit isn't set up on this server yet" });
      return;
    }
    const tenantId = tenantIdOf(res);
    const account = `${billing.dashboardOrigin}/tenants/${tenantId}/settings`;
    const result = await startDirectDebit(pool, billing.payments, tenantId, {
      redirectUrl: `${account}?directDebit=done`,
      exitUrl: account,
      actorUserId: principalOf(res).userId,
      now: now?.() ?? new Date(),
    });
    switch (result.outcome) {
      case "started":
        res.status(201).json({
          authorisationUrl: result.authorisationUrl,
        } satisfies DirectDebitStartView);
        return;
      case "already-active":
        res.status(409).json({ error: "This business already has a Direct Debit set up" });
        return;
      case "not-allowed":
        res.status(409).json({
          error: `The account is ${result.status}, so there's nothing to pay for`,
          status: result.status,
        });
        return;
      case "not-found":
        res.status(404).json({ error: "Not found" });
        return;
    }
  });

  // Back from the provider's page: is the Direct Debit set up yet? Asks the provider, records
  // the answer, and returns the billing view.
  tenant.post("/billing/direct-debit/check", async (_req, res) => {
    if (!billing) {
      res.status(503).json({ error: "Direct Debit isn't set up on this server yet" });
      return;
    }
    const tenantId = tenantIdOf(res);
    await checkDirectDebit(pool, billing.payments, tenantId, enqueueOnboardingWith(boss));
    const view = await loadBillingView(pool, tenantId, {
      now: now?.() ?? new Date(),
      available: true,
    });
    if (!view) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(view satisfies BillingView);
  });

  // One table of the business's data as CSV, for a spreadsheet (BUILD_PLAN Step 13).
  tenant.get("/export.csv", async (req, res) => {
    const table = csvExportQuery.safeParse(req.query);
    if (!table.success) {
      res.status(400).json({ error: "Choose a table: " + CSV_EXPORTS.join(", ") });
      return;
    }
    const csv = await exportTenantCsv(pool, tenantIdOf(res), table.data.table);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="answermate-${table.data.table}.csv"`,
    );
    // A byte-order mark first: without one, Excel on Windows reads a CSV in the PC's own code
    // page and garbles £ signs and curly quotes.
    res.send(`\uFEFF${csv}`);
  });

  // Everything we hold for the tenant, as one JSON file.
  tenant.get("/export", async (_req, res) => {
    const tenantId = tenantIdOf(res);
    const data = await exportTenant(pool, tenantId);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="answermate-export-${tenantId}.json"`,
    );
    res.json(data);
  });

  tenant.get("/calls", async (req, res) => {
    const tenantId = tenantIdOf(res);
    const query = callListQuery.safeParse(req.query);
    if (!query.success) {
      res
        .status(400)
        .json({ error: "Invalid query", issues: z.flattenError(query.error).fieldErrors });
      return;
    }
    const { urgency, from, to, before, limit, needsReply } = query.data;
    // One more than asked for tells us whether there's another page, without a COUNT.
    const rows = await withTenant(
      pool,
      tenantId,
      async (client) =>
        (
          await client.query<CallRow>(
            `SELECT ${CALL_VIEW_COLUMNS} FROM calls
             WHERE ($1::text IS NULL OR urgency = $1)
               AND ($2::timestamptz IS NULL OR started_at >= $2)
               AND ($3::timestamptz IS NULL OR started_at < $3)
               AND ($4::timestamptz IS NULL OR started_at < $4)
               AND (NOT $6::boolean OR (${NEEDS_REPLY_SQL}))
             ORDER BY started_at DESC, id DESC
             LIMIT $5`,
            [urgency ?? null, from ?? null, to ?? null, before ?? null, limit + 1, needsReply],
          )
        ).rows,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    res.json({
      calls: page.map(presentCallSummary),
      nextBefore: rows.length > limit && last ? last.started_at.toISOString() : null,
    } satisfies CallListView);
  });

  /** Loads one call inside its tenant, or answers 404 and returns null. */
  async function loadCall(tenantId: string, callId: string, res: import("express").Response) {
    if (!z.uuid().safeParse(callId).success) {
      res.status(404).json({ error: "Not found" });
      return null;
    }
    const call = await withTenant(
      pool,
      tenantId,
      async (client) =>
        (
          await client.query<CallRow>(`SELECT ${CALL_VIEW_COLUMNS} FROM calls WHERE id = $1`, [
            callId,
          ])
        ).rows[0],
    );
    if (!call) res.status(404).json({ error: "Not found" });
    return call ?? null;
  }

  tenant.get("/calls/:callId", async (req, res) => {
    const tenantId = tenantIdOf(res);
    const { callId } = req.params;
    const call = await loadCall(tenantId, callId, res);
    if (!call) return;
    res.json(presentCall(call, `/api/tenants/${tenantId}/calls/${call.id}/recording`, sources));
  });

  // "Called back", or open again. The owner and the admin (the reseller never reaches a
  // business's routes); audited with who did it.
  tenant.put("/calls/:callId/handled", async (req, res) => {
    const tenantId = tenantIdOf(res);
    const { callId } = req.params;
    const body = callHandledBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Expected { handled: true } or { handled: false }" });
      return;
    }
    const result = z.uuid().safeParse(callId).success
      ? await setCallHandled(pool, {
          tenantId,
          callId,
          handled: body.data.handled,
          actorUserId: principalOf(res).userId,
          via: "dashboard",
        })
      : null;
    if (!result) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({
      callId,
      handledAt: result.handledAt?.toISOString() ?? null,
    } satisfies CallHandledView);
  });

  tenant.get("/calls/:callId/recording", async (req, res) => {
    const tenantId = tenantIdOf(res);
    const { callId } = req.params;
    const call = await loadCall(tenantId, callId, res);
    if (!call) return;
    await streamRecording(req, res, tenantId, call, sources);
  });

  return router;
}

function presentProfile(row: ProfileRow, isAdmin: boolean): ProfileView {
  return {
    // Checked against the schema when saved; the editor checks again before saving back.
    profile: {
      trade: row.trade_template,
      services: row.services,
      serviceAreas: row.service_areas,
      openingHours: row.opening_hours,
      holidayMode: row.holiday_mode,
      holidayUntil: row.holiday_until,
      faqs: row.faqs,
      emergencyPolicy: row.emergency_policy,
    } as AgentProfileInput,
    version: row.version,
    sync: {
      state: row.synced_at ? "live" : row.sync_error ? "error" : "pending",
      syncedAt: row.synced_at?.toISOString() ?? null,
      // The voice platform's own words, which can name its internals: Phil's to read. The
      // tradesperson sees that it failed, and an alert has already gone to Phil.
      error: isAdmin ? row.sync_error : null,
    },
  };
}

function presentTenantSummary(tenant: TenantWithCallCounts): TenantListItem {
  return {
    id: tenant.id,
    businessName: tenant.businessName,
    trade: tenant.trade,
    status: tenant.status,
    onboardingState: tenant.onboardingState,
    createdAt: tenant.createdAt.toISOString(),
    calls: { last30Days: tenant.callsLast30Days, total: tenant.callsTotal },
    billing: {
      isPilot: tenant.isPilot,
      directDebit: tenant.directDebit,
      lastCharge: tenant.lastCharge,
    },
  };
}
