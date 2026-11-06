// The seam between CallMate and the phone-number provider (Twilio). Numbers, their webhook
// configuration, and verifying that a webhook really came from the provider.

export interface AvailableNumber {
  /** E.164. */
  number: string;
  locality: string | null;
  region: string | null;
}

export interface NumberSearch {
  /** Digits the number should contain, such as an area code: "0113". */
  contains?: string;
  limit?: number;
}

/** Where the provider sends a call: our API for routing, and the static voicemail if that fails. */
export interface NumberConfiguration {
  voiceUrl: string;
  voiceFallbackUrl: string;
  friendlyName?: string;
}

export interface PurchasedNumber {
  providerSid: string;
  number: string;
}

/** Thrown when a purchase is attempted without both guards: purchases enabled and `live: true`. */
export class PurchaseNotAllowedError extends Error {
  override readonly name = "PurchaseNotAllowedError";
}

export interface WebhookRequest {
  /** The exact public URL the provider called, including the query string. */
  url: string;
  /** The form-encoded body, as sent. */
  params: Record<string, string>;
  signature: string | undefined;
}

export interface TelephonyProvider {
  /** UK geographic (01/02) numbers that can receive calls. */
  searchNumbers(search: NumberSearch): Promise<AvailableNumber[]>;
  /**
   * Buys a number. Costs money, so it refuses unless the adapter was created with purchases
   * enabled and the caller passes `{ live: true }`; only `live-*` scripts and admin actions do.
   */
  purchaseNumber(
    number: string,
    config: NumberConfiguration,
    options: { live: boolean },
  ): Promise<PurchasedNumber>;
  configureNumber(providerSid: string, config: NumberConfiguration): Promise<void>;
  /** Releases a number back to the provider. Safe to repeat. */
  releaseNumber(providerSid: string): Promise<void>;
  /** True when the request was signed by the provider for exactly this URL and body. */
  verifyWebhook(request: WebhookRequest): boolean;
}
