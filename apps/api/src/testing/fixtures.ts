import { randomUUID } from "node:crypto";
import type pg from "pg";

// Fictional data only (CLAUDE.md). Numbers are from Ofcom's drama ranges.

/**
 * Creates a tenant with one call and one blocked number, using the owner role. Row-level
 * security is forced, so even the owner needs the tenant set to write the rows.
 */
export async function createTenantWithData(owner: pg.Pool, businessName: string) {
  const tenantId = randomUUID();
  const callId = randomUUID();
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await client.query(
      "INSERT INTO tenants (id, business_name, trade) VALUES ($1, $2, 'plumber')",
      [tenantId, businessName],
    );
    await client.query(
      `INSERT INTO calls (id, tenant_id, provider_call_id, caller_number, started_at)
       VALUES ($1, $2, $3, '+447700900123', now())`,
      [callId, tenantId, `call_${randomUUID()}`],
    );
    await client.query(
      "INSERT INTO blocked_numbers (tenant_id, number) VALUES ($1, '+447700900999')",
      [tenantId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { tenantId, callId };
}
