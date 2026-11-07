// The seam between CallMate and the SMS provider (Twilio). The caller has already applied
// the outbound allowlist; the adapter only sends.

export interface SmsMessage {
  /** E.164. */
  to: string;
  /** GSM-7 text (see core/sms.ts); the adapter doesn't re-check. */
  body: string;
}

export interface SmsReceipt {
  providerRef: string;
  /** How many segments the provider billed, when it says. */
  segments: number | null;
}

export interface SmsProvider {
  send(message: SmsMessage): Promise<SmsReceipt>;
  /**
   * Deletes a text we sent, its body included, by the reference `send` returned. Safe to
   * repeat: one that's already gone counts as deleted. For deleting a business's data
   * (BUILD_PLAN Step 13).
   */
  deleteMessage(providerRef: string): Promise<void>;
}
