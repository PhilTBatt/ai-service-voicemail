// The notify-email job (BUILD_PLAN Step 6): the email version of the call text, with the
// transcript and the links, or a "new voicemail" email. Composes; deliver-notification.ts
// applies the allowlist and records the send. The provider adapter follows decision 010.
import type pg from "pg";
import { raiseAlert, type AlertFn } from "../alerts.ts";
import { storedFieldsSchema } from "../core/extraction.ts";
import { callEmail, voicemailEmail } from "../core/notifications.ts";
import type { OutboundPolicy } from "../core/outbound-allowlist.ts";
import { CALL_LINK_TTL_MS, callPageUrl, signCallLink } from "../core/signed-links.ts";
import { withTenant } from "../db/tenant.ts";
import type { EmailProvider } from "../providers/email.ts";
import { deliverNotification, type DeliveryOutcome } from "./deliver-notification.ts";
import { parseTranscript } from "./process-call.ts";

export interface NotifyEmailJobData {
  tenantId: string;
  callId: string;
}

export interface NotifyEmailDeps {
  pool: pg.Pool;
  email: EmailProvider;
  outbound: OutboundPolicy;
  signingSecret: string;
  publicBaseUrl: string;
  alert?: AlertFn;
  now?: () => Date;
}

export type NotifyEmailOutcome = DeliveryOutcome | "no-email";

export async function runNotifyEmail(
  {
    pool,
    email,
    outbound,
    signingSecret,
    publicBaseUrl,
    alert = raiseAlert,
    now = () => new Date(),
  }: NotifyEmailDeps,
  { tenantId, callId }: NotifyEmailJobData,
): Promise<NotifyEmailOutcome> {
  const loaded = await withTenant(pool, tenantId, async (client) => {
    const call = (
      await client.query<{
        summary: string | null;
        urgency: "emergency" | "urgent" | "routine" | "spam" | "other" | null;
        extracted_fields: unknown;
        caller_number: string | null;
        via_fallback: boolean;
        billable_seconds: number;
        transcript: string | null;
        started_at: Date;
        recording_ref: string | null;
        flags: string[];
      }>(
        `SELECT summary, urgency, extracted_fields, caller_number, via_fallback, billable_seconds,
                transcript, started_at, recording_ref, flags
         FROM calls WHERE id = $1`,
        [callId],
      )
    ).rows[0];
    if (!call) throw new Error(`Call ${callId} not found for tenant ${tenantId}`);
    const tenant = (
      await client.query<{ notification_email: string | null; business_name: string }>(
        "SELECT notification_email, business_name FROM tenants WHERE id = $1",
        [tenantId],
      )
    ).rows[0];
    if (!tenant) throw new Error(`Tenant ${tenantId} not found`);
    return { call, tenant };
  });
  const { call, tenant } = loaded;

  if (!call.via_fallback && call.summary === null) {
    throw new Error(`Call ${callId} has not been processed`);
  }

  const to = tenant.notification_email;
  if (!to) {
    alert("notification-no-email", { tenantId, callId });
    return "no-email";
  }

  const token = signCallLink(
    { callId, expiresAt: new Date(now().getTime() + CALL_LINK_TTL_MS) },
    signingSecret,
  );
  const callUrl = callPageUrl(publicBaseUrl, token);
  const recordingUrl = call.recording_ref === null ? null : `${callUrl}/recording`;

  const parsed = storedFieldsSchema.safeParse(call.extracted_fields);
  const fields = parsed.success ? parsed.data : {};
  const message = call.via_fallback
    ? voicemailEmail({
        businessName: tenant.business_name,
        startedAt: call.started_at,
        callbackNumber: call.caller_number,
        durationSeconds: fields.recordingSeconds ?? 0,
        callUrl,
        recordingUrl,
      })
    : (() => {
        return callEmail({
          businessName: tenant.business_name,
          startedAt: call.started_at,
          urgency: call.urgency,
          callerName: fields.callerName ?? null,
          callbackNumber: fields.callbackNumber ?? call.caller_number,
          postcode: fields.postcode ?? null,
          summary: call.summary ?? "",
          flags: call.flags,
          transcript: call.transcript === null ? null : parseTranscript(call.transcript),
          callUrl,
          recordingUrl,
        });
      })();

  return deliverNotification(
    { pool, outbound, alert },
    {
      tenantId,
      callId,
      channel: "email",
      to,
      send: () => email.send({ to, ...message }),
    },
  );
}
