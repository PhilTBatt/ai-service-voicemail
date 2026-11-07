// The dashboard's on/off switch (BUILD_PLAN Step 10): the same rule as the OFF and ON texts
// in tenant-commands.ts, but with a named person behind it in the audit log.
import type pg from "pg";
import type { TenantStatus } from "@callmate/shared";
import { withTenant } from "./tenant.ts";

export type SwitchResult =
  | { outcome: "paused" | "resumed" | "unchanged"; status: TenantStatus }
  /** Only a live or paused tenant can be switched; anything else is support's business. */
  | { outcome: "not-allowed"; status: TenantStatus };

export async function switchAnswering(
  pool: pg.Pool,
  tenantId: string,
  on: boolean,
  actorUserId: string,
): Promise<SwitchResult> {
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
    const wanted: TenantStatus = on ? "live" : "paused";
    if (row.status === wanted) return { outcome: "unchanged", status: row.status };
    await client.query("UPDATE tenants SET status = $2 WHERE id = $1", [tenantId, wanted]);
    await client.query(
      "INSERT INTO audit_log (tenant_id, actor_user_id, action, details) VALUES ($1, $2, $3, $4)",
      [tenantId, actorUserId, on ? "tenant.resumed" : "tenant.paused", { via: "dashboard" }],
    );
    return { outcome: on ? "resumed" : "paused", status: wanted };
  });
}
