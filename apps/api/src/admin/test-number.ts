// Buying and assigning a number: the live-* script now, an admin action in Step 10.
import { assignPhoneNumber, type AdminPool } from "../db/cross-tenant.ts";
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
}

/**
 * Buys `number`, points it at the API with the static voicemail as fallback, and makes it
 * the tenant's dedicated number (releasing the tenant's previous one in our records).
 * Costs money: refuses without `confirm`, on top of the adapter's own two guards.
 */
export async function buyNumberForTenant(
  { telephony, admin, publicBaseUrl, fallbackVoicemailUrl }: BuyNumberDeps,
  { tenantId, number, confirm }: { tenantId: string; number: string; confirm: boolean },
): Promise<PurchasedNumber> {
  if (!confirm) throw new PurchaseNotAllowedError("Buying a number costs money: pass confirm");

  const bought = await telephony.purchaseNumber(
    number,
    {
      voiceUrl: `${publicBaseUrl}/webhooks/twilio/voice`,
      voiceFallbackUrl: fallbackVoicemailUrl,
      friendlyName: `CallMate ${tenantId}`,
    },
    { live: true },
  );
  // From here the number exists at the provider; if recording it fails, the log has the SID.
  logger.info("Number bought", { tenantId, providerSid: bought.providerSid });

  await admin.query(
    "UPDATE phone_numbers SET status = 'released', released_at = now() WHERE tenant_id = $1 AND status = 'active'",
    [tenantId],
  );
  await assignPhoneNumber(admin, tenantId, bought.number, bought.providerSid);
  return bought;
}
