// The notify-sms job (BUILD_PLAN Step 6): one text to the tradesperson per call. An agent
// call gets the summary once process-call has extracted it; a fallback voicemail gets a
// "new voicemail" text with a link to listen. deliver-sms.ts applies the allowlist and
// records the send.
import type pg from "pg";
import { raiseAlert, type AlertFn } from "../alerts.ts";
import { storedFieldsSchema } from "../core/extraction.ts";
import { callSms, voicemailSms } from "../core/notifications.ts";
import type { OutboundPolicy } from "../core/outbound-allowlist.ts";
import { CALL_LINK_TTL_MS, callPageUrl, signCallLink } from "../core/signed-links.ts";
import { withTenant } from "../db/tenant.ts";
import type { SmsProvider } from "../providers/sms.ts";
import { deliverSms, type DeliveryOutcome } from "./deliver-sms.ts";

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

export type NotifySmsOutcome = DeliveryOutcome | "no-mobile";

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
        via_fallback: boolean;
        billable_seconds: number;
      }>(
        `SELECT summary, urgency, extracted_fields, caller_number, via_fallback, billable_seconds
         FROM calls WHERE id = $1`,
        [callId],
      )
    ).rows[0];
    if (!call) throw new Error(`Call ${callId} not found for tenant ${tenantId}`);
    const tenant = (
      await client.query<{ notification_mobile: string | null }>(
        "SELECT notification_mobile FROM tenants WHERE id = $1",
        [tenantId],
      )
    ).rows[0];
    if (!tenant) throw new Error(`Tenant ${tenantId} not found`);
    return { call, tenant };
  });
  const { call } = loaded;

  // process-call writes the summary before this job exists; a missing one means the job
  // was enqueued some other way. Failing lets the queue retry, then dead-letter it.
  if (!call.via_fallback && call.summary === null) {
    throw new Error(`Call ${callId} has not been processed`);
  }

  const to = loaded.tenant.notification_mobile;
  if (!to) {
    // Onboarding (Step 11) stops a tenant going live without one, so this is a data problem.
    alert("notification-no-mobile", { tenantId, callId });
    return "no-mobile";
  }

  const token = signCallLink(
    { callId, expiresAt: new Date(now().getTime() + CALL_LINK_TTL_MS) },
    signingSecret,
  );
  const callUrl = callPageUrl(publicBaseUrl, token);

  const parsed = storedFieldsSchema.safeParse(call.extracted_fields);
  const fields = parsed.success ? parsed.data : {};
  let text: { body: string; segments: number };
  if (call.via_fallback) {
    // A voicemail: the recording's length is stored with the call (voicemails aren't billed).
    text = voicemailSms({
      callbackNumber: call.caller_number,
      durationSeconds: fields.recordingSeconds ?? 0,
      callUrl,
    });
  } else {
    text = callSms({
      urgency: call.urgency,
      callerName: fields.callerName ?? null,
      callbackNumber: fields.callbackNumber ?? call.caller_number,
      postcode: fields.postcode ?? null,
      summary: call.summary ?? "",
      callUrl,
    });
  }

  return deliverSms(
    { pool, sms, outbound, alert },
    { tenantId, callId, channel: "sms", to, ...text },
  );
}
