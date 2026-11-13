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

/** What the provider says became of a transcription it was asked for (decision 022). */
export interface TranscriptionResult {
  /** The provider's ID for the transcription, as requestTranscription returned it. */
  transcriptionRef: string;
  /** The recording it was of, when the provider says. */
  recordingSid: string | null;
  /** "pending": the provider is still working on it, and will say again. */
  status: "completed" | "failed" | "pending";
  /** The words, in order, as one string; null when failed or there were none. */
  text: string | null;
  /** The provider's confidence, 0 to 1, when it gives one. */
  confidence: number | null;
  durationSeconds: number | null;
  /** Why it failed, in the provider's words, redacted. */
  error: string | null;
}

/** A transcription result the provider sent in a shape the adapter can't read. */
export class TranscriptionCallbackError extends Error {
  override readonly name = "TranscriptionCallbackError";
}

export interface TelephonyProvider {
  /**
   * Asks the provider to transcribe a recording it holds, with the result to be POSTed to
   * `callbackUrl` (a JSON webhook, checked with verifyJsonWebhook and read with
   * parseTranscriptionCallback). Costs money: only called with the voicemail transcription
   * switch on (decision 022). Must be safe to repeat for the same recording.
   */
  requestTranscription(input: {
    recordingSid: string;
    callbackUrl: string;
  }): Promise<{ transcriptionRef: string }>;
  /** Reads a transcription result webhook's JSON body; throws TranscriptionCallbackError if it can't. */
  parseTranscriptionCallback(body: unknown): TranscriptionResult;
  /**
   * True when a JSON-bodied webhook was signed by the provider for exactly this URL (query
   * string included) and these bytes. Twilio signs a JSON body through a bodySHA256 query
   * parameter it adds to the URL it calls.
   */
  verifyJsonWebhook(request: {
    url: string;
    rawBody: Buffer;
    signature: string | undefined;
  }): boolean;
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
  /**
   * The provider's call records for calls to `to` that started on or after the UTC day `since`
   * falls on, and before `until` (when the number was released: a number can be bought again,
   * and the next holder's calls aren't ours to delete). Each comes after the calls it spawned
   * (the leg that dialled the voice platform). For deleting a business's data.
   */
  listCallSids(filter: { to: string; since: Date; until: Date | null }): Promise<string[]>;
  /** Deletes a call record (not its recordings: delete those separately). Safe to repeat. */
  deleteCall(callSid: string): Promise<void>;
  /** The audio of a recording, by the reference stored on the call, or null if the provider no longer has it. */
  fetchRecording(recordingUrl: string): Promise<RecordingAudio | null>;
}
