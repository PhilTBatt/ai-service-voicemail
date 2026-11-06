// The notify-sms job (BUILD_PLAN Step 6): one text to the tradesperson per processed call.
// Idempotent through the notifications row, unique on (call_id, channel): a retried job
// finds the row already 'sent' and stops. Outside production the outbound allowlist decides
// whether the text goes at all (CLAUDE.md rule 4).
import type pg from "pg";
import { z } from "zod";
import { raiseAlert, type AlertFn } from "../alerts.ts";
import { callSms } from "../core/notifications.ts";
import { checkOutbound, type OutboundPolicy } from "../core/outbound-allowlist.ts";
import { CALL_LINK_TTL_MS, callPageUrl, signCallLink } from "../core/signed-links.ts";
import { withTenant } from "../db/tenant.ts";
import { logger } from "../logger.ts";
import type { SmsProvider } from "../providers/sms.ts";

export interface NotifySmsJobData {
  tenantId: string;
  callId: string;
}

export interface NotifySmsDeps {
  pool: pg.Pool;
  sms: SmsProvider;
  outbound: OutboundPolicy;
  signingSecret: string;
  publicBaseUrl: string;
  alert?: AlertFn;
  now?: () => Date;
}

export type NotifySmsOutcome = "sent" | "blocked" | "already-sent" | "no-mobile";

type NotificationStatus = "pending" | "sent" | "failed" | "blocked";

// What process-call stored. Only the fields the text needs; anything else is ignored.
const storedFields = z.looseObject({
  callerName: z.string().nullable().optional(),
  callbackNumber: z.string().nullable().optional(),
  postcode: z.string().nullable().optional(),
});

export async function runNotifySms(
  {
    pool,
    sms,
    outbound,
    signingSecret,
    publicBaseUrl,
    alert = raiseAlert,
    now = () => new Date(),
  }: NotifySmsDeps,
  { tenantId, callId }: NotifySmsJobData,
): Promise<NotifySmsOutcome> {
  const loaded = await withTenant(pool, tenantId, async (client) => {
    const call = (
      await client.query<{
        summary: string | null;
        urgency: "emergency" | "urgent" | "routine" | "spam" | "other" | null;
        extracted_fields: unknown;
        caller_number: string | null;
      }>("SELECT summary, urgency, extracted_fields, caller_number FROM calls WHERE id = $1", [
        callId,
      ])
    ).rows[0];
    if (!call) throw new Error(`Call ${callId} not found for tenant ${tenantId}`);
    const tenant = (
      await client.query<{ notification_mobile: string | null }>(
        "SELECT notification_mobile FROM tenants WHERE id = $1",
        [tenantId],
      )
    ).rows[0];
    if (!tenant) throw new Error(`Tenant ${tenantId} not found`);
    const existing = (
      await client.query<{ status: NotificationStatus }>(
        "SELECT status FROM notifications WHERE call_id = $1 AND channel = 'sms'",
        [callId],
      )
    ).rows[0];
    return { call, tenant, existing };
  });

  if (loaded.existing?.status === "sent") {
    logger.info("SMS already sent", { tenantId, callId });
    return "already-sent";
  }
  if (loaded.existing?.status === "blocked") return "blocked";
  // process-call writes the summary before this job exists; a missing one means the job
  // was enqueued some other way. Failing lets the queue retry, then dead-letter it.
  if (loaded.call.summary === null) throw new Error(`Call ${callId} has not been processed`);

  const to = loaded.tenant.notification_mobile;
  if (!to) {
    // Onboarding (Step 11) stops a tenant going live without one, so this is a data problem.
    alert("notification-no-mobile", { tenantId, callId });
    return "no-mobile";
  }

  const parsed = storedFields.safeParse(loaded.call.extracted_fields);
  const fields = parsed.success ? parsed.data : {};
  const token = signCallLink(
    { callId, expiresAt: new Date(now().getTime() + CALL_LINK_TTL_MS) },
    signingSecret,
  );
  const { body, segments } = callSms({
    urgency: loaded.call.urgency,
    callerName: fields.callerName ?? null,
    callbackNumber: fields.callbackNumber ?? loaded.call.caller_number,
    postcode: fields.postcode ?? null,
    summary: loaded.call.summary,
    callUrl: callPageUrl(publicBaseUrl, token),
  });

  // One row per call and channel. 'pending' counts an attempt; the other statuses just
  // record how that attempt ended.
  const setStatus = (status: NotificationStatus, providerRef: string | null = null) =>
    withTenant(pool, tenantId, (client) =>
      client.query(
        `INSERT INTO notifications (tenant_id, call_id, channel, status, attempts, provider_ref)
         VALUES ($1, $2, 'sms', $3, 1, $4)
         ON CONFLICT (call_id, channel) DO UPDATE
           SET status = EXCLUDED.status,
               provider_ref = COALESCE(EXCLUDED.provider_ref, notifications.provider_ref),
               attempts = notifications.attempts
                 + CASE WHEN EXCLUDED.status = 'pending' THEN 1 ELSE 0 END`,
        [tenantId, callId, status, providerRef],
      ),
    );

  const decision = checkOutbound(outbound, to);
  if (!decision.allowed) {
    await setStatus("blocked");
    logger.warn("SMS blocked by the outbound allowlist", {
      tenantId,
      callId,
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
      `UPDATE notifications SET status = 'sent', provider_ref = $2
       WHERE call_id = $1 AND channel = 'sms'`,
      [callId, receipt.providerRef],
    );
    await client.query(
      `INSERT INTO call_costs (tenant_id, call_id, component, units, unit_type, is_estimated)
       VALUES ($1, $2, 'sms:segments', $3, 'segments', $4)`,
      [tenantId, callId, billedSegments, receipt.segments === null],
    );
  });
  logger.info("SMS sent", { tenantId, callId, segments: billedSegments });
  return "sent";
}
