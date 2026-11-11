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
 * undo a suspension, because they only move between live and paused. Each suspension is
 * recorded with when it started and ended, for billing.
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
    // The suspension's own record, which billing reads: a month suspended from its first day
    // to its last isn't charged (tenant_suspensions; charge-periods.ts).
    if (suspend) {
      await client.query(
        "INSERT INTO tenant_suspensions (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) WHERE ended_at IS NULL DO NOTHING",
        [tenantId],
      );
    } else {
      await client.query(
        "UPDATE tenant_suspensions SET ended_at = now() WHERE tenant_id = $1 AND ended_at IS NULL",
        [tenantId],
      );
    }
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

export type UndoCancellationResult =
  { outcome: "restored"; status: TenantStatus } | { outcome: "not-allowed"; status: TenantStatus };

const RESTORABLE: readonly TenantStatus[] = ["live", "paused", "suspended", "onboarding"];

/**
 * Takes back a cancellation (an audit finding, 2026-11-11: before this, a tradesperson who
 * changed their mind heard "service has ended" for 30 days, with only SQL to fix it). Only
 * while the business is still cancelling, i.e. its number hasn't been released. It goes back to
 * the status it left from, as the cancellation's own audit row recorded it (read through the
 * admin pool, the only one that may read the log), or paused if that can't be found, so the
 * owner switches it on themselves.
 */
export async function undoCancellation(
  pool: pg.Pool,
  admin: pg.Pool,
  tenantId: string,
  actorUserId: string,
): Promise<UndoCancellationResult> {
  const recorded = (
    await admin.query<{ from: string | null }>(
      `SELECT details->>'from' AS "from" FROM audit_log
       WHERE tenant_id = $1 AND action = 'tenant.cancel-requested'
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId],
    )
  ).rows[0]?.from;
  const restore: TenantStatus = RESTORABLE.includes(recorded as TenantStatus)
    ? (recorded as TenantStatus)
    : "paused";
  return withTenant(pool, tenantId, async (client) => {
    const row = (
      await client.query<{ status: TenantStatus }>(
        "SELECT status FROM tenants WHERE id = $1 FOR UPDATE",
        [tenantId],
      )
    ).rows[0];
    if (!row) throw new Error(`Tenant ${tenantId} not found`);
    if (row.status !== "cancelling") return { outcome: "not-allowed", status: row.status };
    await client.query(
      "UPDATE tenants SET status = $2, cancellation_requested_at = NULL WHERE id = $1",
      [tenantId, restore],
    );
    // A business that left while suspended has a suspension still open. Back to suspended, it
    // stays open; back to anything else (paused, when the audit row can't be read), it ends
    // here, or every month after would be billed as suspended throughout, and resume (which
    // only acts on a suspended business) could never close it.
    if (restore !== "suspended") {
      await client.query(
        "UPDATE tenant_suspensions SET ended_at = now() WHERE tenant_id = $1 AND ended_at IS NULL",
        [tenantId],
      );
    }
    await client.query(
      "INSERT INTO audit_log (tenant_id, actor_user_id, action, details) VALUES ($1, $2, 'tenant.cancel-undone', $3)",
      [tenantId, actorUserId, { via: "dashboard", to: restore }],
    );
    return { outcome: "restored", status: restore };
  });
}
