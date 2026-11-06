import type pg from "pg";
import type { TenantStatus } from "@callmate/shared";
import { openingHoursSchema } from "../core/profile.ts";
import type { InboundCallContext } from "../core/routing.ts";
import { findTenantIdByNumber } from "./cross-tenant.ts";
import { withTenant } from "./tenant.ts";

/**
 * Everything the routing decision needs about an inbound call. The tenant comes from the
 * dialled number (the only way a tenant is ever identified); the rest is read inside that
 * tenant's transaction, so nothing else can leak in.
 */
export async function loadInboundCallContext(
  pool: pg.Pool,
  { to, from }: { to: string; from: string | null },
): Promise<InboundCallContext> {
  const { rows: settings } = await pool.query<{ kill_switch_on: boolean }>(
    "SELECT kill_switch_on FROM system_settings",
  );
  const killSwitchOn = settings[0]?.kill_switch_on ?? false;

  const tenantId = await findTenantIdByNumber(pool, to);
  if (tenantId === null) return { tenant: null, callerBlocked: false, killSwitchOn };

  return withTenant(pool, tenantId, async (client) => {
    const tenant = (
      await client.query<{ status: TenantStatus; notification_mobile: string | null }>(
        "SELECT status, notification_mobile FROM tenants WHERE id = $1",
        [tenantId],
      )
    ).rows[0];
    if (!tenant) return { tenant: null, callerBlocked: false, killSwitchOn };

    // The latest synced profile is the one the live agent was built from.
    const profile = (
      await client.query<{
        provider_agent_id: string;
        opening_hours: unknown;
        holiday_mode: boolean;
        holiday_until: string | null;
      }>(
        `SELECT provider_agent_id, opening_hours, holiday_mode,
                to_char(holiday_until, 'YYYY-MM-DD') AS holiday_until
         FROM agent_profiles WHERE tenant_id = $1 AND synced_at IS NOT NULL
         ORDER BY version DESC LIMIT 1`,
        [tenantId],
      )
    ).rows[0];

    const blocked =
      from !== null &&
      (
        await client.query("SELECT 1 FROM blocked_numbers WHERE tenant_id = $1 AND number = $2", [
          tenantId,
          from,
        ])
      ).rowCount === 1;

    return {
      tenant: {
        id: tenantId,
        status: tenant.status,
        notificationMobile: tenant.notification_mobile,
        providerAgentId: profile?.provider_agent_id ?? null,
        availability: {
          openingHours: profile ? openingHoursSchema.parse(profile.opening_hours) : {},
          holidayMode: profile?.holiday_mode ?? false,
          holidayUntil: profile?.holiday_until ?? null,
        },
      },
      callerBlocked: blocked,
      killSwitchOn,
    };
  });
}
