import type pg from "pg";
import { z } from "zod";

const tenantIdSchema = z.uuid();

/**
 * Runs `fn` in a transaction scoped to one tenant: row-level security then only lets it
 * see and write that tenant's rows. All tenant-facing database access goes through here.
 *
 * The tenant is set with set_config(..., true), which lasts until the transaction ends.
 * A plain `SET` would stay on the pooled connection and leak into whichever request
 * borrows it next.
 */
export async function withTenant<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  tenantIdSchema.parse(tenantId);

  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    // If even ROLLBACK fails, the connection is unusable: discard it rather than return it.
    await client.query("ROLLBACK").catch(() => {
      broken = true;
    });
    throw error;
  } finally {
    client.release(broken);
  }
}
