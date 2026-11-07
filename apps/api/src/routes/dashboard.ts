// The dashboard's API (BUILD_PLAN Step 10): what the React app calls once a person is logged
// in: who am I, the tenants I can see, a tenant's calls, its agent profile, the on/off switch,
// notification settings, the data export and the cancellation request.
//
// Tenant data is read inside withTenant(), so row-level security backs up the middleware:
// even a bug in requireTenantAccess() couldn't hand one tenant's calls to another. The
// cross-tenant list (admin and reseller) uses the admin pool, as the admin screens are meant to.
import {
  URGENCIES,
  type CallListView,
  type AgentProfileInput,
  type CancellationView,
  type MeView,
  type NotificationSettings,
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
import { agentProfileInputSchema, saveAgentProfile } from "../db/agent-profiles.ts";
import { adminRouter } from "./admin.ts";
import {
  listTenantsWithCallCounts,
  type AdminPool,
  type TenantWithCallCounts,
} from "../db/cross-tenant.ts";
import { withTenant } from "../db/tenant.ts";
import {
  exportTenant,
  notificationSettingsSchema,
  requestCancellation,
  updateNotificationSettings,
} from "../db/tenant-settings.ts";
import { switchAnswering } from "../db/tenant-switch.ts";
import type { AuthProvider } from "../providers/auth.ts";
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
});

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

export function dashboardRouter({
  pool,
  admin,
  auth,
  boss,
  telephony,
  voice,
  now,
}: DashboardOptions) {
  const router = Router();
  const sources: RecordingSources = { telephony, voice };
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
  // to. The reseller's view is this list and nothing below it: counts, never content.
  router.get("/tenants", requireRole("owner", "admin", "reseller"), async (_req, res) => {
    const principal = principalOf(res);
    const all = await listTenantsWithCallCounts(admin);
    const visible =
      principal.role === "owner"
        ? all.filter((tenant) => principal.tenantIds.includes(tenant.id))
        : all;
    res.json({ tenants: visible.map(presentTenantSummary) } satisfies TenantListView);
  });

  router.use("/admin", adminRouter({ pool, admin, ...(now && { now }) }));

  const tenant = Router({ mergeParams: true });
  router.use("/tenants/:tenantId", requireTenantAccess(), tenant);

  tenant.get("/", async (_req, res) => {
    const tenantId = tenantIdOf(res);
    const row = await withTenant(
      pool,
      tenantId,
      async (client) =>
        (
          await client.query<TenantRow>(
            `SELECT id, business_name, trade, status, contact_name, notification_mobile,
                    notification_email, service_region, created_at
             FROM tenants WHERE id = $1`,
            [tenantId],
          )
        ).rows[0],
    );
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({
      id: row.id,
      businessName: row.business_name,
      trade: row.trade,
      status: row.status,
      contactName: row.contact_name,
      notificationMobile: row.notification_mobile,
      notificationEmail: row.notification_email,
      serviceRegion: row.service_region,
      createdAt: row.created_at.toISOString(),
    } satisfies TenantView);
  });

  // The agent profile: what the tenant edits, plus how the sync of the latest version is
  // going ("live in about a minute", or the error). Null before the first save.
  tenant.get("/profile", async (_req, res) => {
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
        ? presentProfile(row)
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

  // Where texts and emails go. Null clears a channel; the delivery jobs then skip it.
  tenant.put("/notifications", async (req, res) => {
    const tenantId = tenantIdOf(res);
    const body = notificationSettingsSchema.safeParse(req.body);
    if (!body.success) {
      res
        .status(400)
        .json({ error: "Invalid settings", issues: z.flattenError(body.error).fieldErrors });
      return;
    }
    const saved = await updateNotificationSettings(
      pool,
      tenantId,
      body.data,
      principalOf(res).userId,
    );
    res.json(saved satisfies NotificationSettings);
  });

  // Asking to leave: callers hear "service has ended" from now on. The rest is Step 13.
  tenant.post("/cancel", async (_req, res) => {
    const tenantId = tenantIdOf(res);
    const result = await requestCancellation(pool, tenantId, principalOf(res).userId);
    if (result.outcome === "not-allowed") {
      res.status(409).json({
        error: `The account is ${result.status}, so there's nothing to cancel from here`,
        status: result.status,
      });
      return;
    }
    res.json(result satisfies CancellationView);
  });

  // Everything we hold for the tenant, as one JSON file (CSV comes with Step 13).
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
    const { urgency, from, to, before, limit } = query.data;
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
             ORDER BY started_at DESC, id DESC
             LIMIT $5`,
            [urgency ?? null, from ?? null, to ?? null, before ?? null, limit + 1],
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

  tenant.get("/calls/:callId/recording", async (req, res) => {
    const tenantId = tenantIdOf(res);
    const { callId } = req.params;
    const call = await loadCall(tenantId, callId, res);
    if (!call) return;
    await streamRecording(res, tenantId, call, sources);
  });

  return router;
}

function presentProfile(row: ProfileRow): ProfileView {
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
      error: row.sync_error,
    },
  };
}

function presentTenantSummary(tenant: TenantWithCallCounts): TenantListItem {
  return {
    id: tenant.id,
    businessName: tenant.businessName,
    trade: tenant.trade,
    status: tenant.status,
    createdAt: tenant.createdAt.toISOString(),
    calls: { last30Days: tenant.callsLast30Days, total: tenant.callsTotal },
  };
}
