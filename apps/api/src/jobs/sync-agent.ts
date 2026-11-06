// The sync-agent job: turns a saved profile into a live agent on the voice platform.
// Idempotent on tenant + profile version: the queue allows one such job at a time, and the
// job itself skips a version that's already synced.
import type { PgBoss } from "pg-boss";
import type pg from "pg";
import { raiseAlert, type AlertFn } from "../alerts.ts";
import { tenantProfileSchema } from "../core/profile.ts";
import { buildAgentDefinition } from "../core/prompt-builder.ts";
import { withTenant } from "../db/tenant.ts";
import { logger } from "../logger.ts";
import type { VoiceProvider } from "../providers/voice.ts";
import { SYNC_AGENT_QUEUE } from "./queue.ts";

export interface SyncAgentJobData {
  tenantId: string;
  profileVersion: number;
}

/** Queues a sync. Returns null when one for this tenant and version is already queued or running. */
export function enqueueSyncAgent(boss: PgBoss, data: SyncAgentJobData): Promise<string | null> {
  return boss.send(SYNC_AGENT_QUEUE, data, {
    singletonKey: `${data.tenantId}:${data.profileVersion}`,
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
}

export async function runSyncAgent(
  { pool, voice, alert = raiseAlert }: SyncAgentDeps,
  { tenantId, profileVersion }: SyncAgentJobData,
): Promise<"synced" | "already-synced"> {
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
                to_char(holiday_until, 'YYYY-MM-DD') AS holiday_until, faqs, emergency_policy, synced_at
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

    return { tenant, profile, existingProviderAgentId: previous?.provider_agent_id ?? null };
  });

  if (loaded.profile.synced_at) {
    logger.info("Agent already synced", { tenantId, profileVersion });
    return "already-synced";
  }

  try {
    if (!loaded.tenant.contact_name) {
      throw new Error(
        "Tenant has no contact name yet; onboarding must collect it before the agent can sync",
      );
    }
    const definition = buildAgentDefinition(
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

    const { providerAgentId } = await voice.upsertAgent({
      definition,
      existingProviderAgentId: loaded.existingProviderAgentId,
    });
    await withTenant(pool, tenantId, (client) =>
      client.query(
        `UPDATE agent_profiles SET provider_agent_id = $3, synced_at = now(), sync_error = NULL
         WHERE tenant_id = $1 AND version = $2`,
        [tenantId, profileVersion, providerAgentId],
      ),
    );
    logger.info("Agent synced", { tenantId, profileVersion, providerAgentId });
    return "synced";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await withTenant(pool, tenantId, (client) =>
      client.query(
        "UPDATE agent_profiles SET sync_error = $3 WHERE tenant_id = $1 AND version = $2",
        [tenantId, profileVersion, message],
      ),
    );
    alert("agent-sync-failed", { tenantId, profileVersion, error });
    throw error; // so the queue retries, and dead-letters after the last attempt
  }
}
