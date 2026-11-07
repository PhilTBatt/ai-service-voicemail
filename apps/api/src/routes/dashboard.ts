// The dashboard's API (BUILD_PLAN Step 10): what the React app calls once a person is logged
// in. Reads only, so far: who am I, the tenants I can see, and a tenant's calls.
//
// Tenant data is read inside withTenant(), so row-level security backs up the middleware:
// even a bug in requireTenantAccess() couldn't hand one tenant's calls to another. The
// cross-tenant list (admin and reseller) uses the admin pool, as the admin screens are meant to.
import { Router } from "express";
import type pg from "pg";
import { z } from "zod";
import {
  listTenantsWithCallCounts,
  type AdminPool,
  type TenantWithCallCounts,
} from "../db/cross-tenant.ts";
import { withTenant } from "../db/tenant.ts";
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
}

export const CALL_LIST_DEFAULT_LIMIT = 50;
export const CALL_LIST_MAX_LIMIT = 200;

const URGENCIES = ["emergency", "urgent", "routine", "spam", "other"] as const;

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

export function dashboardRouter({ pool, admin, auth, telephony, voice }: DashboardOptions) {
  const router = Router();
  const sources: RecordingSources = { telephony, voice };

  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.use(authenticate(pool, auth));

  router.get("/me", (_req, res) => {
    const { userId, email, role, tenantIds } = principalOf(res);
    res.json({ userId, email, role, tenantIds });
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
    res.json({ tenants: visible.map(presentTenantSummary) });
  });

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
    });
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
    });
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

function presentTenantSummary(tenant: TenantWithCallCounts) {
  return {
    id: tenant.id,
    businessName: tenant.businessName,
    trade: tenant.trade,
    status: tenant.status,
    createdAt: tenant.createdAt.toISOString(),
    calls: { last30Days: tenant.callsLast30Days, total: tenant.callsTotal },
  };
}
