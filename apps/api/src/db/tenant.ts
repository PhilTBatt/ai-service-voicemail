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
  // A connection that dies while checked out (the database restarting or failing over) emits
  // an 'error' event as well as failing the query in flight. The pool only listens while the
  // connection is idle, so with nobody listening here Node would treat it as uncaught and stop
  // the whole process, every call and request with it. The failed query already reports it.
  const onError = () => {
    broken = true;
  };
  client.on("error", onError);
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
    client.removeListener("error", onError);
    client.release(broken);
  }
}
