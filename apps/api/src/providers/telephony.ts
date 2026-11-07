// The seam between CallMate and the phone-number provider (Twilio). Numbers, their webhook
// configuration, and verifying that a webhook really came from the provider.
import type { RecordingAudio } from "./recording.ts";

export type { RecordingAudio } from "./recording.ts";

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
  /** Where inbound texts go (SMS commands). Only a mobile number can receive them. */
  smsUrl?: string;
  friendlyName?: string;
}

/** Monthly rental for a kind of UK number, as the provider prices it for this account. */
export interface NumberPrice {
  type: "local" | "mobile" | "national" | "toll free";
  /** Decimal string, in `currency`, per month. */
  monthly: string;
  currency: string;
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

/** A recording held at the provider, as listed by the reconciliation job. */
export interface RecordingSummary {
  recordingSid: string;
  callSid: string;
  /** Where the audio can be fetched (with the provider's credentials). */
  url: string;
  durationSeconds: number;
  createdAt: Date;
}

export interface CallDetails {
  callSid: string;
  /** E.164, or null when withheld. */
  from: string | null;
  /** E.164: the number that was dialled. */
  to: string;
  startedAt: Date;
  endedAt: Date | null;
  durationSeconds: number;
}

export interface TelephonyProvider {
  /** UK geographic (01/02) numbers that can receive calls. */
  searchNumbers(search: NumberSearch): Promise<AvailableNumber[]>;
  /** What UK numbers cost to rent per month, by kind. */
  numberPrices(): Promise<NumberPrice[]>;
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
  /** Recordings made since a point in time, for finding voicemails whose callback never arrived. */
  listRecentRecordings(window: { since: Date }): Promise<RecordingSummary[]>;
  /** The numbers and times of a call, or null if the provider doesn't know it. */
  getCall(callSid: string): Promise<CallDetails | null>;
  /** Deletes a recording held at the provider. Safe to repeat. */
  deleteRecording(recordingSid: string): Promise<void>;
  /** The audio of a recording, by the reference stored on the call, or null if the provider no longer has it. */
  fetchRecording(recordingUrl: string): Promise<RecordingAudio | null>;
}
