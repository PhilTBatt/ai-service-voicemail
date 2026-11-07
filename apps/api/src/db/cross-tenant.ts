// ┌──────────────────────────────────────────────────────────────────────────────────────┐
// │ CROSS-TENANT ACCESS. Everything that can reach more than one tenant's data lives      │
// │ here, and only here. Tenant-facing code uses withTenant() (./tenant.ts) instead.       │
// └──────────────────────────────────────────────────────────────────────────────────────┘
import type { Trade } from "@callmate/shared";
import type pg from "pg";
import { createPool } from "./pool.ts";

/**
 * Finds which tenant owns an active number, for webhooks that arrive before any tenant is
 * known. Runs as the app role through a database function that returns only the tenant ID.
 */
export async function findTenantIdByNumber(
  appPool: pg.Pool,
  dialledNumber: string,
): Promise<string | null> {
  const { rows } = await appPool.query<{ tenant_id: string | null }>(
    "SELECT tenant_id_for_number($1) AS tenant_id",
    [dialledNumber],
  );
  return rows[0]?.tenant_id ?? null;
}

/**
 * Finds the tenant whose registered mobile sent a text, for the SMS command webhook. Only an
 * unambiguous match counts: two tenants sharing a mobile get nothing (and no reply).
 */
export async function findTenantIdByMobile(
  appPool: pg.Pool,
  mobile: string,
): Promise<string | null> {
  const { rows } = await appPool.query<{ tenant_id: string | null }>(
    "SELECT tenant_id_for_mobile($1) AS tenant_id",
    [mobile],
  );
  return rows[0]?.tenant_id ?? null;
}

/** Finds the tenant a call belongs to, for the signed call page (the link carries only the call ID). */
export async function findTenantIdByCall(appPool: pg.Pool, callId: string): Promise<string | null> {
  const { rows } = await appPool.query<{ tenant_id: string | null }>(
    "SELECT tenant_id_for_call($1) AS tenant_id",
    [callId],
  );
  return rows[0]?.tenant_id ?? null;
}

// The admin pool is "branded": a plain pg.Pool (like the app's) doesn't fit this type, so
// admin functions can't be handed the wrong connection by mistake.
export type AdminPool = pg.Pool & { readonly __brand: "AdminPool" };

/** Connects as callmate_admin, which sees every tenant. Only for admin work and seeding. */
export function createAdminPool(adminDatabaseUrl: string): AdminPool {
  return createPool(adminDatabaseUrl) as AdminPool;
}

export interface NewTenant {
  /** Normally generated. Seed data passes a fixed one so re-running the seed is harmless. */
  id?: string;
  businessName: string;
  trade: Trade;
  status?: "onboarding" | "demo";
  notificationMobile?: string;
  notificationEmail?: string;
  serviceRegion?: "GB" | "NI";
  /** The tradesperson's name, as callers will hear it. Required before the agent can sync. */
  contactName?: string;
}

export async function createTenant(admin: AdminPool, tenant: NewTenant): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO tenants (id, business_name, trade, status, notification_mobile, notification_email, service_region, contact_name)
     VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      tenant.id ?? null,
      tenant.businessName,
      tenant.trade,
      tenant.status ?? "onboarding",
      tenant.notificationMobile ?? null,
      tenant.notificationEmail ?? null,
      tenant.serviceRegion ?? "GB",
      tenant.contactName ?? null,
    ],
  );
  return rows[0]!.id;
}

/** Gives a tenant its dedicated number. The database allows one active number per tenant. */
export async function assignPhoneNumber(
  admin: AdminPool,
  tenantId: string,
  number: string,
  providerSid: string,
): Promise<void> {
  await admin.query(
    "INSERT INTO phone_numbers (tenant_id, number, provider_sid) VALUES ($1, $2, $3)",
    [tenantId, number, providerSid],
  );
}

export interface TenantSummary {
  id: string;
  businessName: string;
  status: string;
}

export async function listTenants(admin: AdminPool): Promise<TenantSummary[]> {
  const { rows } = await admin.query<TenantSummary>(
    `SELECT id, business_name AS "businessName", status FROM tenants ORDER BY created_at`,
  );
  return rows;
}

// ─── Retention (BUILD_PLAN Step 5) ─────────────────────────────────────────────────────
// Runs across every tenant, so it lives here with the other cross-tenant code.

export interface ExpiredRecording {
  tenantId: string;
  callId: string;
  providerCallId: string;
  recordingRef: string;
  viaFallback: boolean;
}

/** Calls whose recording is older than the retention period and not yet deleted. */
export async function findExpiredRecordings(
  admin: AdminPool,
  olderThan: Date,
  limit = 200,
): Promise<ExpiredRecording[]> {
  const { rows } = await admin.query<ExpiredRecording>(
    `SELECT tenant_id AS "tenantId", id AS "callId", provider_call_id AS "providerCallId",
            recording_ref AS "recordingRef", via_fallback AS "viaFallback"
     FROM calls WHERE recording_ref IS NOT NULL AND started_at < $1
     ORDER BY started_at LIMIT $2`,
    [olderThan, limit],
  );
  return rows;
}

/** Forgets a recording once the provider has deleted it. */
export async function clearRecording(admin: AdminPool, callId: string): Promise<void> {
  await admin.query("UPDATE calls SET recording_ref = NULL WHERE id = $1", [callId]);
}

/** Deletes transcripts, summaries and extracted fields older than the retention period. Returns the count. */
export async function clearExpiredTranscripts(admin: AdminPool, olderThan: Date): Promise<number> {
  const result = await admin.query(
    `UPDATE calls SET transcript = NULL, summary = NULL, extracted_fields = '{}'
     WHERE started_at < $1 AND (transcript IS NOT NULL OR summary IS NOT NULL OR extracted_fields <> '{}')`,
    [olderThan],
  );
  return result.rowCount ?? 0;
}

/** Of these provider call IDs, the ones whose call row exists and has ended (across tenants). */
export async function findCompletedProviderCallIds(
  admin: AdminPool,
  providerCallIds: string[],
): Promise<Set<string>> {
  if (providerCallIds.length === 0) return new Set();
  const { rows } = await admin.query<{ provider_call_id: string }>(
    "SELECT provider_call_id FROM calls WHERE provider_call_id = ANY($1) AND ended_at IS NOT NULL",
    [providerCallIds],
  );
  return new Set(rows.map((r) => r.provider_call_id));
}

/**
 * Makes a newly bought number the tenant's dedicated one, releasing their previous number
 * in our records, in one transaction: a tenant never ends up with no active number.
 */
export async function reassignNumber(
  admin: AdminPool,
  tenantId: string,
  number: string,
  providerSid: string,
): Promise<void> {
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE phone_numbers SET status = 'released', released_at = now() WHERE tenant_id = $1 AND status = 'active'",
      [tenantId],
    );
    await client.query(
      "INSERT INTO phone_numbers (tenant_id, number, provider_sid) VALUES ($1, $2, $3)",
      [tenantId, number, providerSid],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
