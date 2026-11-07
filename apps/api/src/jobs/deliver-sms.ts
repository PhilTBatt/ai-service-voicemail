// Sends one text and records it, through deliver-notification.ts. SMS is metered, so the
// segment count the provider billed goes into call_costs.
import type pg from "pg";
import type { OutboundPolicy } from "../core/outbound-allowlist.ts";
import type { SmsProvider } from "../providers/sms.ts";
import { deliverNotification, type DeliveryOutcome } from "./deliver-notification.ts";

export type { DeliveryOutcome, NotificationStatus } from "./deliver-notification.ts";

/** 'sms' is the call summary; the other two are the emergency texts. */
export type SmsChannel = "sms" | "sms_emergency" | "sms_caller";

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

export interface SmsDeliveryDeps {
  pool: pg.Pool;
  sms: SmsProvider;
  outbound: OutboundPolicy;
}

export async function deliverSms(
  { pool, sms, outbound }: SmsDeliveryDeps,
  { tenantId, callId, channel, to, body, segments }: SmsDelivery,
): Promise<DeliveryOutcome> {
  return deliverNotification(
    { pool, outbound },
    {
      tenantId,
      callId,
      channel,
      to,
      send: async () => {
        const receipt = await sms.send({ to, body });
        return {
          providerRef: receipt.providerRef,
          cost: {
            component: "sms:segments",
            units: receipt.segments ?? segments,
            unitType: "segments",
            isEstimated: receipt.segments === null,
          },
        };
      },
    },
  );
}
