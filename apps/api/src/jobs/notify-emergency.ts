// The notify-emergency job (BUILD_PLAN Step 6). For a call the extraction marked as an
// emergency: a short priority text to the tradesperson straight away (the full summary
// follows from notify-sms), and, when the agent spoke the gas script, a service message
// to the caller with the gas emergency number. Each text is idempotent through its own
// notifications channel. Queued mid-call by the flow's emergency function (with the kind),
// and again after the call by process-call (the second run finds the texts already sent).
import type pg from "pg";
import { raiseAlert, type AlertFn } from "../alerts.ts";
import { storedFieldsSchema } from "../core/extraction.ts";
import { emergencyCallerSms, emergencyTradespersonSms } from "../core/notifications.ts";
import type { OutboundPolicy } from "../core/outbound-allowlist.ts";
import { withTenant } from "../db/tenant.ts";
import { logger } from "../logger.ts";
import type { SmsProvider } from "../providers/sms.ts";
import { deliverSms, type DeliveryOutcome } from "./deliver-sms.ts";

export interface NotifyEmergencyJobData {
  tenantId: string;
  callId: string;
  /** Set when queued mid-call by the flow's function; absent after the call, when the transcript decides. */
  kind?: "gas" | "danger";
}

export interface NotifyEmergencyDeps {
  pool: pg.Pool;
  sms: SmsProvider;
  outbound: OutboundPolicy;
  alert?: AlertFn;
}

export type NotifyEmergencyOutcome =
  | "not-emergency"
  | {
      tradesperson: DeliveryOutcome | "no-mobile";
      caller: DeliveryOutcome | "no-number" | "not-gas";
    };

/** The agent spoke Appendix A's gas script: the only case where the caller gets a text. */
export function gasScriptSpoken(transcript: string | null): boolean {
  return (
    transcript !== null &&
    transcript.split("\n").some((line) => /^agent: .*National Gas Emergency Service/i.test(line))
  );
}

export async function runNotifyEmergency(
  { pool, sms, outbound, alert = raiseAlert }: NotifyEmergencyDeps,
  { tenantId, callId, kind }: NotifyEmergencyJobData,
): Promise<NotifyEmergencyOutcome> {
  const loaded = await withTenant(pool, tenantId, async (client) => {
    const call = (
      await client.query<{
        urgency: string | null;
        caller_number: string | null;
        transcript: string | null;
        extracted_fields: unknown;
      }>("SELECT urgency, caller_number, transcript, extracted_fields FROM calls WHERE id = $1", [
        callId,
      ])
    ).rows[0];
    if (!call) throw new Error(`Call ${callId} not found for tenant ${tenantId}`);
    const tenant = (
      await client.query<{
        business_name: string;
        notification_mobile: string | null;
        service_region: "GB" | "NI";
      }>("SELECT business_name, notification_mobile, service_region FROM tenants WHERE id = $1", [
        tenantId,
      ])
    ).rows[0];
    if (!tenant) throw new Error(`Tenant ${tenantId} not found`);
    return { call, tenant };
  });

  // Queued mid-call, the kind is authoritative: the agent spoke the script. Queued after
  // the call, the extraction's urgency decides.
  if (kind === undefined && loaded.call.urgency !== "emergency") {
    logger.info("Emergency job for a call that isn't one; nothing sent", { tenantId, callId });
    return "not-emergency";
  }

  const parsed = storedFieldsSchema.safeParse(loaded.call.extracted_fields);
  const callbackNumber =
    (parsed.success ? parsed.data.callbackNumber : null) ?? loaded.call.caller_number;
  const deps = { pool, sms, outbound };

  let tradesperson: DeliveryOutcome | "no-mobile";
  if (loaded.tenant.notification_mobile) {
    const text = emergencyTradespersonSms({ callbackNumber });
    tradesperson = await deliverSms(deps, {
      tenantId,
      callId,
      channel: "sms_emergency",
      to: loaded.tenant.notification_mobile,
      ...text,
    });
  } else {
    alert("notification-no-mobile", { tenantId, callId });
    tradesperson = "no-mobile";
  }

  let caller: DeliveryOutcome | "no-number" | "not-gas";
  if (kind !== "gas" && !gasScriptSpoken(loaded.call.transcript)) {
    caller = "not-gas";
  } else if (loaded.call.caller_number === null) {
    caller = "no-number"; // withheld: nowhere to send it
  } else {
    const text = emergencyCallerSms({
      businessName: loaded.tenant.business_name,
      region: loaded.tenant.service_region,
    });
    caller = await deliverSms(deps, {
      tenantId,
      callId,
      channel: "sms_caller",
      to: loaded.call.caller_number,
      ...text,
    });
  }

  logger.info("Emergency texts handled", { tenantId, callId, tradesperson, caller });
  return { tradesperson, caller };
}
