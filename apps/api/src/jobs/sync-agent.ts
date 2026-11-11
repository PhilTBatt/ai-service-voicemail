// The sync-agent job: turns a saved profile into a live agent on the voice platform.
// Idempotent on tenant + profile version: the queue allows one such job at a time, and the
// job itself skips a version that's already synced, unless what it would send the platform has
// changed since (a release changed the prompt): then it sends it again.
import type { PgBoss } from "pg-boss";
import type pg from "pg";
import { raiseAlert, type AlertFn } from "../alerts.ts";
import type { AgentDefinition } from "../core/agent.ts";
import { tenantProfileSchema } from "../core/profile.ts";
import { buildAgentDefinition } from "../core/prompt-builder.ts";
import { listLatestProfilesWithLiveAgents, type AdminPool } from "../db/cross-tenant.ts";
import { withTenant } from "../db/tenant.ts";
import { logger } from "../logger.ts";
import type { VoiceProvider } from "../providers/voice.ts";
import { SYNC_AGENT_QUEUE } from "./queue.ts";

export interface SyncAgentJobData {
  tenantId: string;
  profileVersion: number;
}

/**
 * Queues a sync. Returns null when one for this tenant and version is already queued or
 * running. Given a client, the job is written through that transaction, so it commits or
 * rolls back with the profile row.
 */
export function enqueueSyncAgent(
  boss: PgBoss,
  data: SyncAgentJobData,
  client?: pg.ClientBase,
): Promise<string | null> {
  return boss.send(SYNC_AGENT_QUEUE, data, {
    singletonKey: `${data.tenantId}:${data.profileVersion}`,
    ...(client && {
      db: { executeSql: (text: string, values?: unknown[]) => client.query(text, values) },
    }),
  });
}

export interface SyncAgentDeps {
  pool: pg.Pool;
  voice: VoiceProvider;
  alert?: AlertFn;
}

interface ProfileRow {
  trade_template: string;
  services: unknown;
  service_areas: unknown;
  opening_hours: unknown;
  holiday_mode: boolean;
  holiday_until: string | null;
  faqs: unknown;
  emergency_policy: unknown;
  synced_at: Date | null;
  synced_fingerprint: string | null;
}

export async function runSyncAgent(
  { pool, voice, alert = raiseAlert }: SyncAgentDeps,
  { tenantId, profileVersion }: SyncAgentJobData,
): Promise<"synced" | "already-synced" | "superseded" | "business-left"> {
  // Read everything in one tenant transaction, then talk to the platform with no
  // transaction open: an HTTP call can take seconds and shouldn't hold a connection.
  const loaded = await withTenant(pool, tenantId, async (client) => {
    const tenant = (
      await client.query<{
        business_name: string;
        contact_name: string | null;
        status: string;
        service_region: "GB" | "NI";
      }>("SELECT business_name, contact_name, status, service_region FROM tenants WHERE id = $1", [
        tenantId,
      ])
    ).rows[0];
    if (!tenant) throw new Error(`Tenant ${tenantId} not found`);

    const profile = (
      await client.query<ProfileRow>(
        `SELECT trade_template, services, service_areas, opening_hours, holiday_mode,
                to_char(holiday_until, 'YYYY-MM-DD') AS holiday_until, faqs, emergency_policy, synced_at,
                synced_fingerprint
         FROM agent_profiles WHERE tenant_id = $1 AND version = $2`,
        [tenantId, profileVersion],
      )
    ).rows[0];
    if (!profile)
      throw new Error(`Profile version ${profileVersion} not found for tenant ${tenantId}`);

    const previous = (
      await client.query<{ provider_agent_id: string }>(
        `SELECT provider_agent_id FROM agent_profiles
         WHERE tenant_id = $1 AND provider_agent_id IS NOT NULL ORDER BY version DESC LIMIT 1`,
        [tenantId],
      )
    ).rows[0];

    // A newer version already synced (this job is a late retry): touching the platform agent
    // now would put an older prompt live and undo the tenant's latest edit.
    const newer = await client.query(
      `SELECT 1 FROM agent_profiles
       WHERE tenant_id = $1 AND version > $2 AND synced_at IS NOT NULL LIMIT 1`,
      [tenantId, profileVersion],
    );

    return {
      tenant,
      profile,
      existingProviderAgentId: previous?.provider_agent_id ?? null,
      superseded: (newer.rowCount ?? 0) > 0,
    };
  });

  // A newer version is live: never put an older one back, whatever changed.
  if (loaded.superseded) {
    logger.info("Agent sync superseded by a newer version", { tenantId, profileVersion });
    return "superseded";
  }
  // Leaving or gone: its calls hear "service has ended", and deleting its data deletes its agent.
  // A sync now (a re-check queued just before it left) could make a new agent holding its prompt.
  if (loaded.tenant.status === "cancelling" || loaded.tenant.status === "cancelled") {
    logger.info("Agent not synced: the business is leaving", { tenantId, profileVersion });
    return "business-left";
  }
  const resync = loaded.profile.synced_at !== null;

  const recordFailure = async (error: unknown): Promise<never> => {
    const message = error instanceof Error ? error.message : String(error);
    await withTenant(pool, tenantId, (client) =>
      client.query(
        "UPDATE agent_profiles SET sync_error = $3 WHERE tenant_id = $1 AND version = $2",
        [tenantId, profileVersion, message],
      ),
    );
    alert("agent-sync-failed", { tenantId, profileVersion, error });
    throw error; // so the queue retries, and dead-letters after the last attempt
  };

  let definition: AgentDefinition;
  try {
    if (!loaded.tenant.contact_name) {
      throw new Error(
        "Tenant has no contact name yet; onboarding must collect it before the agent can sync",
      );
    }
    definition = buildAgentDefinition(
      tenantProfileSchema.parse({
        tenantId,
        profileVersion,
        businessName: loaded.tenant.business_name,
        tradespersonName: loaded.tenant.contact_name,
        trade: loaded.profile.trade_template,
        serviceRegion: loaded.tenant.service_region,
        isDemo: loaded.tenant.status === "demo",
        services: loaded.profile.services,
        serviceAreas: loaded.profile.service_areas,
        openingHours: loaded.profile.opening_hours,
        holidayMode: loaded.profile.holiday_mode,
        holidayUntil: loaded.profile.holiday_until,
        faqs: loaded.profile.faqs,
        emergencyPolicy: loaded.profile.emergency_policy,
      }),
    );
  } catch (error) {
    if (!resync) return recordFailure(error);
    // A version that's live but no longer builds (a profile saved under older rules): its agent
    // keeps the prompt it has, and the row isn't marked failed, since it isn't. Said once, not
    // retried: trying again builds the same profile with the same code.
    alert("agent-sync-failed", { tenantId, profileVersion, error, stillLive: true });
    return "already-synced";
  }

  // Synced, and today's code would send the platform exactly what it was sent then: nothing to
  // do. A release that changed the prompt, the scripts or the adapter (or the API's address)
  // changes the fingerprint, and the same version is sent again.
  const fingerprint = voice.agentFingerprint(definition);
  if (resync && loaded.profile.synced_fingerprint === fingerprint) {
    logger.info("Agent already synced", { tenantId, profileVersion });
    return "already-synced";
  }

  try {
    const { providerAgentId } = await voice.upsertAgent({
      definition,
      existingProviderAgentId: loaded.existingProviderAgentId,
    });
    await withTenant(pool, tenantId, (client) =>
      client.query(
        `UPDATE agent_profiles
         SET provider_agent_id = $3, synced_at = now(), sync_error = NULL, synced_fingerprint = $4
         WHERE tenant_id = $1 AND version = $2`,
        [tenantId, profileVersion, providerAgentId, fingerprint],
      ),
    );
    logger.info(resync ? "Agent re-synced: what it's sent has changed" : "Agent synced", {
      tenantId,
      profileVersion,
      providerAgentId,
    });
    return "synced";
  } catch (error) {
    return recordFailure(error);
  }
}

/**
 * How long after start-up the worker re-checks every agent. A release starts the new worker
 * before the old one stops, and the old one works the same queue: given a re-check job, it would
 * compare against its own (old) build, find nothing changed and finish the job, leaving that agent
 * on the old prompt. Two minutes is our estimate of that overlap (Azure doesn't document it for
 * an app without ingress); the release check itself waits for the new worker's check-in.
 */
export const RESYNC_CHECK_DELAY_MS = 2 * 60_000;

/**
 * Queues a sync of the latest profile version of every business with a live agent; each one
 * re-sends the agent only if what it would send has changed (runSyncAgent), and a latest version
 * whose own sync failed (a platform outage when it was saved) is tried again. Run by the worker
 * once, after start-up, so a release that changes the prompt reaches every agent, not just the
 * ones edited after it. One that can't be queued is logged and the rest carry on.
 */
export async function enqueueAgentResyncs(
  admin: AdminPool,
  boss: PgBoss,
): Promise<{ queued: number; failed: number }> {
  const counts = { queued: 0, failed: 0 };
  for (const { tenantId, version } of await listLatestProfilesWithLiveAgents(admin)) {
    try {
      // Null when one for that version is already queued or running: it will do.
      if ((await enqueueSyncAgent(boss, { tenantId, profileVersion: version })) !== null) {
        counts.queued++;
      }
    } catch (error) {
      counts.failed++;
      logger.error("Couldn't queue an agent's re-check", { tenantId, error });
    }
  }
  return counts;
}
