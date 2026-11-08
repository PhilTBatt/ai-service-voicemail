import type { PgBoss } from "pg-boss";
import type pg from "pg";
import { agentProfileInputSchema, type AgentProfileInput } from "@callmate/shared";
import { enqueueSyncAgent } from "../jobs/sync-agent.ts";
import { withTenant } from "./tenant.ts";

// What a tenant (or admin) edits, and its rules, live in packages/shared/src/profile.ts so the
// dashboard checks a profile exactly as the API does.
export { agentProfileInputSchema, type AgentProfileInput };

/**
 * Saves a new profile version and queues its sync. Every save is a new version, so the
 * history is kept and the sync job is idempotent on tenant + version. Given an actor (a
 * dashboard save), the audit row names them; a script passes none, and the row says "script".
 * Either way it's written in the same transaction.
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
    await client.query(
      "INSERT INTO audit_log (tenant_id, actor_user_id, action, details) VALUES ($1, $2, 'profile.saved', $3)",
      [tenantId, actor?.userId ?? null, { via: actor ? "dashboard" : "script", version: saved }],
    );
    return saved;
  });
  return version;
}
