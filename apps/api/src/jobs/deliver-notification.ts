// Sends one notification and records it: the shared tail of every notification job, for
// any channel. The notifications row, unique on (call_id, channel), makes a retried job stop
// once the message has gone; the outbound allowlist decides whether it goes at all outside
// production (CLAUDE.md rule 4). The channel-specific part is the `send` callback.
import type pg from "pg";
import { checkOutbound, type OutboundPolicy } from "../core/outbound-allowlist.ts";
import { withTenant } from "../db/tenant.ts";
import { logger } from "../logger.ts";

/** 'sms' and 'email' are the call summaries; the other two are the emergency texts. */
export type NotificationChannel = "sms" | "sms_emergency" | "sms_caller" | "email";

export type NotificationStatus = "pending" | "sent" | "failed" | "blocked";

export type DeliveryOutcome = "sent" | "blocked" | "already-sent";

/** What a send cost, when the channel is metered (SMS segments are; email isn't). */
export interface DeliveryCost {
  component: string;
  units: number;
  unitType: string;
  isEstimated: boolean;
}

export interface Delivery {
  tenantId: string;
  callId: string;
  channel: NotificationChannel;
  /** E.164 number or email address: what the allowlist is checked against. */
  to: string;
  /** Does the actual send. Only called once the allowlist allows it. */
  send: () => Promise<{ providerRef: string; cost?: DeliveryCost }>;
}

export interface DeliveryDeps {
  pool: pg.Pool;
  outbound: OutboundPolicy;
}

export async function deliverNotification(
  { pool, outbound }: DeliveryDeps,
  { tenantId, callId, channel, to, send }: Delivery,
): Promise<DeliveryOutcome> {
  const existing = await withTenant(
    pool,
    tenantId,
    async (client) =>
      (
        await client.query<{ status: NotificationStatus }>(
          "SELECT status FROM notifications WHERE call_id = $1 AND channel = $2",
          [callId, channel],
        )
      ).rows[0],
  );
  if (existing?.status === "sent") {
    logger.info("Notification already sent", { tenantId, callId, channel });
    return "already-sent";
  }
  if (existing?.status === "blocked") return "blocked";

  // One row per call and channel. 'pending' counts an attempt; the other statuses just
  // record how that attempt ended.
  const setStatus = (status: NotificationStatus, providerRef: string | null = null) =>
    withTenant(pool, tenantId, (client) =>
      client.query(
        `INSERT INTO notifications (tenant_id, call_id, channel, status, attempts, provider_ref)
         VALUES ($1, $2, $3, $4, 1, $5)
         ON CONFLICT (call_id, channel) DO UPDATE
           SET status = EXCLUDED.status,
               provider_ref = COALESCE(EXCLUDED.provider_ref, notifications.provider_ref),
               attempts = notifications.attempts
                 + CASE WHEN EXCLUDED.status = 'pending' THEN 1 ELSE 0 END`,
        [tenantId, callId, channel, status, providerRef],
      ),
    );

  const decision = checkOutbound(outbound, to);
  if (!decision.allowed) {
    await setStatus("blocked");
    logger.warn("Notification blocked by the outbound allowlist", {
      tenantId,
      callId,
      channel,
      reason: decision.reason,
    });
    return "blocked";
  }

  await setStatus("pending");
  let result;
  try {
    result = await send();
  } catch (error) {
    await setStatus("failed");
    throw error; // the queue retries with backoff; the row shows how many times
  }
  await withTenant(pool, tenantId, async (client) => {
    await client.query(
      `UPDATE notifications SET status = 'sent', provider_ref = $3
       WHERE call_id = $1 AND channel = $2`,
      [callId, channel, result.providerRef],
    );
    if (result.cost) {
      await client.query(
        `INSERT INTO call_costs (tenant_id, call_id, component, units, unit_type, is_estimated)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          tenantId,
          callId,
          result.cost.component,
          result.cost.units,
          result.cost.unitType,
          result.cost.isEstimated,
        ],
      );
    }
  });
  logger.info("Notification sent", { tenantId, callId, channel });
  return "sent";
}
