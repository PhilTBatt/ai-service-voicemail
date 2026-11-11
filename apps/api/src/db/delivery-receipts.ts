// Delivery receipts: what Twilio (texts) and Postmark (emails) say became of a message we sent,
// matched to its notifications row by the provider's own message ID.
//
// The provider can call back within milliseconds of accepting a message, before the send job
// has saved that ID (jobs/deliver-notification.ts), and Twilio doesn't reliably retry a status
// callback. A receipt that matched nothing used to be dropped, and an 'undelivered' one took its
// alert with it. Now a receipt that matches nothing is kept (early_receipts), and the send job
// takes it back and applies it in the same transaction that saves the ID. Both sides first take
// a lock on the ID, so they go one at a time, and whichever goes second sees what the first
// committed: either the receipt finds the saved ID, or the send job finds the kept receipt.
import type pg from "pg";
import { z } from "zod";
import { ALERTS, type AlertFn, type AlertName } from "../alerts.ts";
import { findTenantIdByProviderRef } from "./cross-tenant.ts";
import { withTenant } from "./tenant.ts";

/**
 * How long a receipt that matches nothing is kept. The race it covers lasts milliseconds, and
 * the receipts for texts that aren't notifications (onboarding and cancellation texts) never
 * match, so an hour is ample and the table stays small.
 */
export const EARLY_RECEIPT_KEEP_MINUTES = 60;

/** Whose ID it is: Twilio's for a text, Postmark's for an email. */
export type ReceiptMedium = "sms" | "email";

export interface ReceiptAlert {
  name: AlertName;
  /** What the alert says besides the business and the call: codes and flags, never content. */
  details: Record<string, string | boolean | null>;
}

/** A provider's final verdict on one message, as the webhook route read it. */
export interface DeliveryReceipt {
  medium: ReceiptMedium;
  providerRef: string;
  status: "delivered" | "undelivered";
  failureCode: string | null;
  /** The alert an undelivered message raises, or null. */
  alert: ReceiptAlert | null;
}

/** A receipt applied to its notification, and the alert that's now due (null if none is). */
export interface AppliedReceipt {
  callId: string;
  alert: ReceiptAlert | null;
}

/** The medium a notification channel's receipts come in on. */
export function mediumOf(channel: string): ReceiptMedium {
  return channel === "email" ? "email" : "sms";
}

/**
 * The lock both sides take on a message ID, held until their transaction ends. The receipt
 * side's lookup and the send side's take-back each run after it, so each sees what the other
 * committed before it got the lock (READ COMMITTED reads from each statement's start).
 */
async function lockRef(client: pg.PoolClient, providerRef: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `delivery-receipt:${providerRef}`,
  ]);
}

/**
 * Applies a receipt to its notification, inside the business's transaction. A message we never
 * recorded as gone ('pending', 'failed') is left alone. The same verdict again (a receipt sent
 * twice, or both kept and redelivered) changes nothing and is never alerted twice.
 */
export async function applyReceipt(
  client: pg.PoolClient,
  receipt: DeliveryReceipt,
): Promise<AppliedReceipt | null> {
  const { rows } = await client.query<{
    id: string;
    call_id: string;
    status: string;
    failure_code: string | null;
  }>(
    `SELECT id, call_id, status, failure_code FROM notifications
     WHERE provider_ref = $1 AND (channel = 'email') = $2
       AND status IN ('sent', 'delivered', 'undelivered')
     FOR UPDATE`,
    [receipt.providerRef, receipt.medium === "email"],
  );
  const previous = rows[0];
  if (!previous) return null;
  if (previous.status === receipt.status && previous.failure_code === receipt.failureCode) {
    return { callId: previous.call_id, alert: null };
  }
  await client.query("UPDATE notifications SET status = $2, failure_code = $3 WHERE id = $1", [
    previous.id,
    receipt.status,
    receipt.failureCode,
  ]);
  return { callId: previous.call_id, alert: receipt.alert };
}

/** Raises the alert an applied receipt carries, once its transaction has committed. */
export function raiseReceiptAlert(
  alert: AlertFn,
  tenantId: string,
  applied: AppliedReceipt | null,
): void {
  if (!applied?.alert) return;
  alert(applied.alert.name, { tenantId, callId: applied.callId, ...applied.alert.details });
}

/**
 * A webhook's receipt: applied to its notification (and alerted) if the ID is saved, or kept
 * for the send job if it isn't yet. Returns the business, or null when the receipt was kept.
 */
export async function recordReceipt(
  pool: pg.Pool,
  receipt: DeliveryReceipt,
  alert: AlertFn,
): Promise<{ tenantId: string | null }> {
  // Nearly every receipt finds its message straight away, without any lock.
  const tenantId =
    (await findTenantIdByProviderRef(pool, receipt.providerRef)) ??
    (await keepUnlessSaved(pool, receipt));
  if (tenantId === null) return { tenantId: null };
  const applied = await withTenant(pool, tenantId, (client) => applyReceipt(client, receipt));
  raiseReceiptAlert(alert, tenantId, applied);
  return { tenantId };
}

/**
 * Under the lock, looks for the ID once more (a send job may have saved it since the first
 * look) and, if it's still nowhere, keeps the receipt. A later receipt for the same message
 * replaces an earlier one, as it would on the notification. Returns the business if the ID
 * turned up after all, so the caller applies the receipt as usual.
 */
async function keepUnlessSaved(pool: pg.Pool, receipt: DeliveryReceipt): Promise<string | null> {
  const client = await pool.connect();
  let broken = false;
  // As in withTenant: a connection that dies while checked out also emits 'error', which with
  // nobody listening would stop the process. The failed query already reports it.
  const onError = () => {
    broken = true;
  };
  client.on("error", onError);
  try {
    await client.query("BEGIN");
    await lockRef(client, receipt.providerRef);
    const { rows } = await client.query<{ tenant_id: string | null }>(
      "SELECT tenant_id_for_provider_ref($1) AS tenant_id",
      [receipt.providerRef],
    );
    const tenantId = rows[0]?.tenant_id ?? null;
    if (tenantId === null) {
      await client.query(
        "DELETE FROM early_receipts WHERE received_at < now() - make_interval(mins => $1)",
        [EARLY_RECEIPT_KEEP_MINUTES],
      );
      await client.query(
        `INSERT INTO early_receipts (medium, provider_ref, status, failure_code, alert, alert_details)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (medium, provider_ref) DO UPDATE
           SET status = EXCLUDED.status, failure_code = EXCLUDED.failure_code,
               alert = EXCLUDED.alert, alert_details = EXCLUDED.alert_details,
               received_at = EXCLUDED.received_at`,
        [
          receipt.medium,
          receipt.providerRef,
          receipt.status,
          receipt.failureCode,
          receipt.alert?.name ?? null,
          receipt.alert?.details ?? {},
        ],
      );
    }
    await client.query("COMMIT");
    return tenantId;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {
      broken = true;
    });
    throw error;
  } finally {
    client.removeListener("error", onError);
    client.release(broken);
  }
}

const keptRowSchema = z.object({
  status: z.enum(["delivered", "undelivered"]),
  failure_code: z.string().nullable(),
  alert: z.enum(ALERTS).nullable(),
  alert_details: z.record(z.string(), z.union([z.string(), z.boolean(), z.null()])),
});

/**
 * For the send job, in the transaction that has just saved a message's ID: takes back a receipt
 * the provider sent before the save, if one was kept, and applies it. The caller raises the
 * alert (raiseReceiptAlert) once that transaction has committed.
 */
export async function applyEarlyReceipt(
  client: pg.PoolClient,
  medium: ReceiptMedium,
  providerRef: string,
): Promise<AppliedReceipt | null> {
  await lockRef(client, providerRef);
  const { rows } = await client.query(
    `DELETE FROM early_receipts WHERE medium = $1 AND provider_ref = $2
     RETURNING status, failure_code, alert, alert_details`,
    [medium, providerRef],
  );
  if (rows.length === 0) return null;
  const kept = keptRowSchema.parse(rows[0]);
  return applyReceipt(client, {
    medium,
    providerRef,
    status: kept.status,
    failureCode: kept.failure_code,
    alert: kept.alert === null ? null : { name: kept.alert, details: kept.alert_details },
  });
}
