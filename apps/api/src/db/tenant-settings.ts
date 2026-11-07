// The tenant's own settings from the dashboard (BUILD_PLAN Step 10): where notifications go,
// and asking to leave. Each write is audited with the person behind it. The audit details
// name which fields changed, never the values: the audit log stays free of contact details.
import type pg from "pg";
import {
  notificationSettingsSchema,
  type NotificationSettings,
  type TenantStatus,
} from "@callmate/shared";
import { withTenant } from "./tenant.ts";

// The rules live in packages/shared/src/settings.ts, so the dashboard checks them too.
export { notificationSettingsSchema, type NotificationSettings };

export async function updateNotificationSettings(
  pool: pg.Pool,
  tenantId: string,
  settings: NotificationSettings,
  actorUserId: string,
): Promise<NotificationSettings> {
  const parsed = notificationSettingsSchema.parse(settings);
  return withTenant(pool, tenantId, async (client) => {
    const before = (
      await client.query<{ notification_mobile: string | null; notification_email: string | null }>(
        "SELECT notification_mobile, notification_email FROM tenants WHERE id = $1 FOR UPDATE",
        [tenantId],
      )
    ).rows[0];
    if (!before) throw new Error(`Tenant ${tenantId} not found`);
    const changed = [
      ...(before.notification_mobile !== parsed.notificationMobile ? ["notificationMobile"] : []),
      ...(before.notification_email !== parsed.notificationEmail ? ["notificationEmail"] : []),
    ];
    if (changed.length > 0) {
      await client.query(
        "UPDATE tenants SET notification_mobile = $2, notification_email = $3 WHERE id = $1",
        [tenantId, parsed.notificationMobile, parsed.notificationEmail],
      );
      await client.query(
        "INSERT INTO audit_log (tenant_id, actor_user_id, action, details) VALUES ($1, $2, 'notifications.changed', $3)",
        [tenantId, actorUserId, { via: "dashboard", changed }],
      );
    }
    return parsed;
  });
}

export type CancellationResult =
  | { outcome: "cancelling"; status: "cancelling" }
  /** Already on the way out, or never live: nothing to cancel from here. */
  | { outcome: "not-allowed"; status: TenantStatus };

/**
 * Starts leaving. From now on callers hear the "service has ended" message (core/routing.ts).
 * Step 13 adds the rest of the timeline: the divert-removal texts, the number's release after
 * 30 days, and the deletion.
 */
export async function requestCancellation(
  pool: pg.Pool,
  tenantId: string,
  actorUserId: string,
): Promise<CancellationResult> {
  return withTenant(pool, tenantId, async (client) => {
    const row = (
      await client.query<{ status: TenantStatus }>(
        "SELECT status FROM tenants WHERE id = $1 FOR UPDATE",
        [tenantId],
      )
    ).rows[0];
    if (!row) throw new Error(`Tenant ${tenantId} not found`);
    if (row.status !== "live" && row.status !== "paused") {
      return { outcome: "not-allowed", status: row.status };
    }
    await client.query("UPDATE tenants SET status = 'cancelling' WHERE id = $1", [tenantId]);
    await client.query(
      "INSERT INTO audit_log (tenant_id, actor_user_id, action, details) VALUES ($1, $2, 'tenant.cancel-requested', $3)",
      [tenantId, actorUserId, { via: "dashboard", from: row.status }],
    );
    return { outcome: "cancelling", status: "cancelling" };
  });
}

/** Everything we hold for one tenant, for the data export. RLS guarantees it's only theirs. */
export async function exportTenant(pool: pg.Pool, tenantId: string) {
  return withTenant(pool, tenantId, async (client) => {
    // One after another: a connection runs one query at a time, and handing it several at once
    // is deprecated in pg (removed in pg 9). They share the transaction, so they see one snapshot.
    const tenant = await client.query(
      `SELECT id, business_name, trade, status, contact_name, notification_mobile, notification_email,
              service_region, created_at, updated_at
       FROM tenants WHERE id = $1`,
      [tenantId],
    );
    const profiles = await client.query(
      `SELECT version, trade_template, services, service_areas, opening_hours, holiday_mode,
              holiday_until, faqs, emergency_policy, synced_at, sync_error, created_at
       FROM agent_profiles WHERE tenant_id = $1 ORDER BY version`,
      [tenantId],
    );
    const calls = await client.query(
      `SELECT id, caller_number, started_at, ended_at, billable_seconds, outcome, urgency, summary,
              extracted_fields, transcript, via_fallback, flags, created_at
       FROM calls WHERE tenant_id = $1 ORDER BY started_at`,
      [tenantId],
    );
    const notifications = await client.query(
      `SELECT call_id, channel, status, attempts, failure_code, created_at, updated_at
       FROM notifications WHERE tenant_id = $1 ORDER BY created_at`,
      [tenantId],
    );
    const audit = await client.query(
      "SELECT action, details, created_at FROM audit_log WHERE tenant_id = $1 ORDER BY created_at",
      [tenantId],
    );
    return {
      exportedAt: new Date().toISOString(),
      tenant: (tenant.rows[0] as Record<string, unknown> | undefined) ?? null,
      agentProfiles: profiles.rows,
      calls: calls.rows,
      notifications: notifications.rows,
      auditLog: audit.rows,
    };
  });
}
