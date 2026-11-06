import type { PgBoss } from "pg-boss";
import type pg from "pg";
import { z } from "zod";
import { tenantProfileSchema } from "../core/profile.ts";
import { enqueueSyncAgent } from "../jobs/sync-agent.ts";
import { withTenant } from "./tenant.ts";

/** What a tenant (or admin) edits. Everything else on the profile comes from the tenant row. */
export const agentProfileInputSchema = tenantProfileSchema.pick({
  trade: true,
  services: true,
  serviceAreas: true,
  openingHours: true,
  holidayMode: true,
  holidayUntil: true,
  faqs: true,
  emergencyPolicy: true,
});
export type AgentProfileInput = z.infer<typeof agentProfileInputSchema>;

/**
 * Saves a new profile version and queues its sync. Every save is a new version, so the
 * history is kept and the sync job is idempotent on tenant + version.
 */
export async function saveAgentProfile(
  pool: pg.Pool,
  boss: PgBoss,
  tenantId: string,
  input: AgentProfileInput,
): Promise<number> {
  const profile = agentProfileInputSchema.parse(input);
  const version = await withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query<{ version: number }>(
      `INSERT INTO agent_profiles
         (tenant_id, version, trade_template, services, service_areas, opening_hours,
          holiday_mode, holiday_until, faqs, emergency_policy)
       VALUES ($1, (SELECT COALESCE(MAX(version), 0) + 1 FROM agent_profiles WHERE tenant_id = $1),
               $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING version`,
      [
        tenantId,
        profile.trade,
        // pg turns JS arrays into Postgres arrays, so jsonb values are stringified first.
        JSON.stringify(profile.services),
        JSON.stringify(profile.serviceAreas),
        JSON.stringify(profile.openingHours),
        profile.holidayMode,
        profile.holidayUntil,
        JSON.stringify(profile.faqs),
        JSON.stringify(profile.emergencyPolicy),
      ],
    );
    return rows[0]!.version;
  });
  await enqueueSyncAgent(boss, { tenantId, profileVersion: version });
  return version;
}
