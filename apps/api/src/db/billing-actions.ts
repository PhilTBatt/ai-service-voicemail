// What an admin can do about a business's billing (BUILD_PLAN Step 12): collect a failed
// payment again, and suspend or resume the business. Never automatic: decision 019 and the
// plan's "no automatic cut-off". Each runs in the business's own transaction, audited by name.
import type { TenantStatus } from "@callmate/shared";
import type pg from "pg";
import type { PaymentsProvider } from "../providers/payments.ts";
import { withTenant } from "./tenant.ts";

export type CollectAgainResult =
  | { outcome: "collecting"; status: string }
  | { outcome: "not-failed"; status: string }
  | { outcome: "not-found" };

/**
 * Asks the provider to collect a failed payment again: the same payment, so its progress
 * comes back through the webhook as before. Only a failed charge with a payment; anything
 * else is refused before the provider is asked.
 */
export async function collectAgain(
  pool: pg.Pool,
  payments: PaymentsProvider,
  tenantId: string,
  chargeId: string,
  actorUserId: string,
): Promise<CollectAgainResult> {
  const charge = await withTenant(
    pool,
    tenantId,
    async (client) =>
      (
        await client.query<{ status: string; payment_ref: string | null }>(
          "SELECT status, payment_ref FROM billing_charges WHERE id = $1",
          [chargeId],
        )
      ).rows[0],
  );
  if (!charge) return { outcome: "not-found" };
  if (charge.status !== "failed" || !charge.payment_ref) {
    return { outcome: "not-failed", status: charge.status };
  }
  await payments.retryPayment(charge.payment_ref);
  await withTenant(pool, tenantId, async (client) => {
    // Back to waiting on the bank. The webhook's "resubmission requested" says the same.
    await client.query(
      "UPDATE billing_charges SET status = 'pending', failure_reason = NULL WHERE id = $1 AND status = 'failed'",
      [chargeId],
    );
    await client.query(
      "INSERT INTO audit_log (tenant_id, actor_user_id, action, details) VALUES ($1, $2, 'billing.collect-again', $3)",
      [tenantId, actorUserId, { chargeId }],
    );
  });
  return { outcome: "collecting", status: "pending" };
}

export type SuspensionResult =
  | { outcome: "suspended" | "resumed" | "unchanged"; status: TenantStatus }
  | { outcome: "not-allowed"; status: TenantStatus };

/**
 * Suspends a business (callers get the fallback voicemail, as routing already does for a
 * suspended one) or resumes it (back to answering). Only an answering or paused business can
 * be suspended, and only a suspended one resumed; the on/off switch and the OFF/ON texts can't
 * undo a suspension, because they only move between live and paused.
 */
export async function setSuspended(
  pool: pg.Pool,
  tenantId: string,
  suspend: boolean,
  actorUserId: string,
): Promise<SuspensionResult> {
  return withTenant(pool, tenantId, async (client) => {
    const row = (
      await client.query<{ status: TenantStatus }>(
        "SELECT status FROM tenants WHERE id = $1 FOR UPDATE",
        [tenantId],
      )
    ).rows[0];
    if (!row) throw new Error(`Tenant ${tenantId} not found`);
    const wanted: TenantStatus = suspend ? "suspended" : "live";
    if (row.status === wanted) return { outcome: "unchanged", status: row.status };
    const allowed = suspend
      ? row.status === "live" || row.status === "paused"
      : row.status === "suspended";
    if (!allowed) return { outcome: "not-allowed", status: row.status };
    await client.query("UPDATE tenants SET status = $2 WHERE id = $1", [tenantId, wanted]);
    await client.query(
      "INSERT INTO audit_log (tenant_id, actor_user_id, action, details) VALUES ($1, $2, $3, $4)",
      [
        tenantId,
        actorUserId,
        suspend ? "tenant.suspended" : "tenant.unsuspended",
        { via: "dashboard" },
      ],
    );
    return { outcome: suspend ? "suspended" : "resumed", status: wanted };
  });
}
