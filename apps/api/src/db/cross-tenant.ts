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
