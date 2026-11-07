// Sends one text and records it: the shared tail of every SMS job. The notifications row,
// unique on (call_id, channel), makes a retried job stop once the text has gone; the
// outbound allowlist decides whether it goes at all outside production (CLAUDE.md rule 4).
import type pg from "pg";
import { checkOutbound, type OutboundPolicy } from "../core/outbound-allowlist.ts";
import { withTenant } from "../db/tenant.ts";
import { logger } from "../logger.ts";
import type { SmsProvider } from "../providers/sms.ts";

/** 'sms' is the call summary; the other two are the emergency texts. */
export type SmsChannel = "sms" | "sms_emergency" | "sms_caller";

export type NotificationStatus = "pending" | "sent" | "failed" | "blocked";

export interface SmsDelivery {
  tenantId: string;
  callId: string;
  channel: SmsChannel;
  /** E.164. */
  to: string;
  /** GSM-7 text. */
  body: string;
  /** Our own segment count, used for the cost row when the provider doesn't report one. */
  segments: number;
}

export type DeliveryOutcome = "sent" | "blocked" | "already-sent";

export interface DeliveryDeps {
  pool: pg.Pool;
  sms: SmsProvider;
  outbound: OutboundPolicy;
}

export async function deliverSms(
  { pool, sms, outbound }: DeliveryDeps,
  { tenantId, callId, channel, to, body, segments }: SmsDelivery,
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
    logger.info("SMS already sent", { tenantId, callId, channel });
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
    logger.warn("SMS blocked by the outbound allowlist", {
      tenantId,
      callId,
      channel,
      reason: decision.reason,
    });
    return "blocked";
  }

  await setStatus("pending");
  let receipt;
  try {
    receipt = await sms.send({ to, body });
  } catch (error) {
    await setStatus("failed");
    throw error; // the queue retries with backoff; the row shows how many times
  }
  const billedSegments = receipt.segments ?? segments;
  await withTenant(pool, tenantId, async (client) => {
    await client.query(
      `UPDATE notifications SET status = 'sent', provider_ref = $3
       WHERE call_id = $1 AND channel = $2`,
      [callId, channel, receipt.providerRef],
    );
    await client.query(
      `INSERT INTO call_costs (tenant_id, call_id, component, units, unit_type, is_estimated)
       VALUES ($1, $2, 'sms:segments', $3, 'segments', $4)`,
      [tenantId, callId, billedSegments, receipt.segments === null],
    );
  });
  logger.info("SMS sent", { tenantId, callId, channel, segments: billedSegments });
  return "sent";
}
