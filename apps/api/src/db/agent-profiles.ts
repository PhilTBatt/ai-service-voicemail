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
 * history is kept and the sync job is idempotent on tenant + version. Given an actor (a
 * dashboard save), the audit row is written in the same transaction; scripts pass none.
 */
export async function saveAgentProfile(
  pool: pg.Pool,
  boss: PgBoss,
  tenantId: string,
  input: AgentProfileInput,
  actor?: { userId: string },
): Promise<number> {
  const profile = agentProfileInputSchema.parse(input);
  const version = await withTenant(pool, tenantId, async (client) => {
    // Two saves at once would compute the same next version; the lock serialises them for
    // this tenant only, and releases itself with the transaction.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [tenantId]);
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
    const saved = rows[0]!.version;
    // Queued through the same transaction: no version is ever saved without its sync job.
    await enqueueSyncAgent(boss, { tenantId, profileVersion: saved }, client);
    if (actor) {
      await client.query(
        "INSERT INTO audit_log (tenant_id, actor_user_id, action, details) VALUES ($1, $2, 'profile.saved', $3)",
        [tenantId, actor.userId, { via: "dashboard", version: saved }],
      );
    }
    return saved;
  });
  return version;
}
