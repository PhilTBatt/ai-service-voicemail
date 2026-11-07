// Buying and assigning a number: used by the live-* script and the admin screen's "buy".
import { raiseAlert, type AlertFn } from "../alerts.ts";
import { reassignNumber, type AdminPool } from "../db/cross-tenant.ts";
import { logger } from "../logger.ts";
import {
  PurchaseNotAllowedError,
  type AvailableNumber,
  type PurchasedNumber,
  type TelephonyProvider,
} from "../providers/telephony.ts";

export function searchNumbers(
  telephony: TelephonyProvider,
  contains?: string,
): Promise<AvailableNumber[]> {
  return telephony.searchNumbers(contains !== undefined ? { contains, limit: 10 } : { limit: 10 });
}

export interface BuyNumberDeps {
  telephony: TelephonyProvider;
  admin: AdminPool;
  publicBaseUrl: string;
  /** The TwiML Bin that plays the static voicemail when the API can't be reached. */
  fallbackVoicemailUrl: string;
  alert?: AlertFn;
}

/**
 * Buys `number`, points it at the API with the static voicemail as fallback, and makes it
 * the tenant's dedicated number (releasing the tenant's previous one in our records).
 * Costs money: refuses without `confirm`, on top of the adapter's own two guards.
 */
export async function buyNumberForTenant(
  { telephony, admin, publicBaseUrl, fallbackVoicemailUrl, alert = raiseAlert }: BuyNumberDeps,
  { tenantId, number, confirm }: { tenantId: string; number: string; confirm: boolean },
): Promise<PurchasedNumber> {
  if (!confirm) throw new PurchaseNotAllowedError("Buying a number costs money: pass confirm");

  const bought = await telephony.purchaseNumber(
    number,
    {
      voiceUrl: `${publicBaseUrl}/webhooks/twilio/voice`,
      voiceFallbackUrl: fallbackVoicemailUrl,
      smsUrl: `${publicBaseUrl}/webhooks/twilio/sms`,
      friendlyName: `CallMate ${tenantId}`,
    },
    { live: true },
  );
  // From here the number exists at the provider and is being paid for. If recording it fails,
  // a person must sort it out (record it by hand, or release it), so that's an alert, not a log.
  logger.info("Number bought", { tenantId, providerSid: bought.providerSid });

  try {
    await reassignNumber(admin, tenantId, bought.number, bought.providerSid);
  } catch (error) {
    alert("number-bought-not-recorded", { tenantId, providerSid: bought.providerSid, error });
    throw error;
  }
  return bought;
}
