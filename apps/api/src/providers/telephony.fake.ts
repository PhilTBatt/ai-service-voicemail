import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  PurchaseNotAllowedError,
  TranscriptionCallbackError,
  type AvailableNumber,
  type CallDetails,
  type NumberConfiguration,
  type NumberPrice,
  type NumberSearch,
  type PurchasedNumber,
  type RecordingAudio,
  type RecordingSummary,
  type TelephonyProvider,
  type TranscriptionResult,
  type WebhookRequest,
} from "./telephony.ts";

/** The fake's result webhook, in Twilio's field names so route tests read like the real thing. */
const fakeTranscriptionCallbackSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["completed", "failed", "pending"]),
  sourceId: z.string().optional(),
  duration: z.number().optional(),
  sentences: z.array(z.object({ text: z.string(), confidence: z.number().optional() })).optional(),
  error: z.object({ message: z.string() }).optional(),
});

/**
 * An in-memory TelephonyProvider for tests. Its stock of numbers is Ofcom's drama range, it
 * applies the same purchase guards as the real adapter, and it signs webhooks over the URL
 * and sorted parameters the way Twilio does (with its own test key).
 */
export class FakeTelephonyProvider implements TelephonyProvider {
  private readonly signingKey = "not-a-real-key";
  readonly available: AvailableNumber[] = Array.from({ length: 5 }, (_, i) => ({
    number: `+44113496010${i}`, // Leeds drama range: 0113 496 0100 to 0104
    locality: "Leeds",
    region: "West Yorkshire",
  }));
  readonly purchased = new Map<string, PurchasedNumber & { config: NumberConfiguration }>();
  readonly released: string[] = [];
  /** What the "provider" holds; tests fill these in. */
  readonly recordings: RecordingSummary[] = [];
  readonly callDetails = new Map<string, CallDetails>();
  readonly deletedRecordings: string[] = [];
  /** Audio by recording URL; tests fill this in. */
  readonly recordingAudio = new Map<string, Uint8Array<ArrayBuffer>>();
  /** Call records at the "provider", by SID; tests fill these in. */
  readonly callRecords = new Map<
    string,
    { to: string; startedAt: Date; parentCallSid: string | null }
  >();
  readonly deletedCalls: string[] = [];
  /** Recording URLs whose stream breaks after the first chunk, for robustness tests. */
  readonly brokenRecordings = new Set<string>();
  /** Every transcription asked for, in order (decision 022). */
  readonly transcriptionRequests: { recordingSid: string; callbackUrl: string }[] = [];
  /** When set, requestTranscription fails with this, for retry tests. */
  transcriptionError: Error | null = null;
  private readonly purchasesEnabled: boolean;

  constructor({ purchasesEnabled = true }: { purchasesEnabled?: boolean } = {}) {
    this.purchasesEnabled = purchasesEnabled;
  }

  requestTranscription(input: { recordingSid: string; callbackUrl: string }) {
    if (this.transcriptionError) return Promise.reject(this.transcriptionError);
    this.transcriptionRequests.push(input);
    return Promise.resolve({
      transcriptionRef: `fake_transcription_${this.transcriptionRequests.length}`,
    });
  }

  parseTranscriptionCallback(body: unknown): TranscriptionResult {
    const parsed = fakeTranscriptionCallbackSchema.safeParse(body);
    if (!parsed.success)
      throw new TranscriptionCallbackError("Transcription result not understood");
    const { id, status, sourceId, duration, sentences, error } = parsed.data;
    const texts = (sentences ?? []).map((sentence) => sentence.text.trim()).filter(Boolean);
    const confidences = (sentences ?? []).flatMap((sentence) =>
      sentence.confidence === undefined ? [] : [sentence.confidence],
    );
    return {
      transcriptionRef: id,
      recordingSid: sourceId ?? null,
      status,
      text: status === "completed" && texts.length > 0 ? texts.join(" ") : null,
      confidence:
        confidences.length > 0
          ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
          : null,
      durationSeconds: duration ?? null,
      error: status === "failed" ? (error?.message ?? "failed") : null,
    };
  }

  verifyJsonWebhook({
    url,
    rawBody,
    signature,
  }: {
    url: string;
    rawBody: Buffer;
    signature: string | undefined;
  }): boolean {
    if (typeof signature !== "string") return false;
    const expected = this.signJson(url, rawBody);
    return (
      signature.length === expected.length &&
      timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    );
  }

  /** Signs a JSON webhook as the provider would: a digest over the URL and the exact bytes. */
  signJson(url: string, rawBody: Buffer | string): string {
    return createHmac("sha1", this.signingKey)
      .update(url)
      .update(typeof rawBody === "string" ? Buffer.from(rawBody) : rawBody)
      .digest("base64");
  }

  numberPrices(): Promise<NumberPrice[]> {
    return Promise.resolve([
      { type: "local", monthly: "0.87", currency: "GBP" },
      { type: "mobile", monthly: "1.89", currency: "GBP" },
    ]);
  }

  searchNumbers({ contains, limit = 10 }: NumberSearch) {
    const national = (n: string) => n.replace(/^\+44/, "0");
    return Promise.resolve(
      this.available
        .filter((n) => !contains || national(n.number).includes(contains))
        .slice(0, limit),
    );
  }

  purchaseNumber(number: string, config: NumberConfiguration, { live }: { live: boolean }) {
    if (!this.purchasesEnabled || !live) {
      return Promise.reject(
        new PurchaseNotAllowedError("Buying a number needs purchases enabled and live: true"),
      );
    }
    if (!this.available.some((n) => n.number === number)) {
      return Promise.reject(new Error(`${number} is not available`));
    }
    // Unique across test runs: provider SIDs are unique in the database.
    const providerSid = `PNfake${randomUUID().replace(/-/g, "")}`;
    this.purchased.set(providerSid, { providerSid, number, config });
    return Promise.resolve({ providerSid, number });
  }

  configureNumber(providerSid: string, config: NumberConfiguration) {
    const owned = this.purchased.get(providerSid);
    if (!owned) return Promise.reject(new Error(`Unknown number ${providerSid}`));
    owned.config = config;
    return Promise.resolve();
  }

  releaseNumber(providerSid: string) {
    this.purchased.delete(providerSid);
    this.released.push(providerSid);
    return Promise.resolve();
  }

  listCallSids({ to, since, until }: { to: string; since: Date; until: Date | null }) {
    // As Twilio does it: from the start of the UTC day `since` falls on, and before `until`.
    const day = (date: Date) => date.toISOString().slice(0, 10);
    const parents = [...this.callRecords]
      .filter(
        ([, record]) =>
          record.to === to &&
          day(record.startedAt) >= day(since) &&
          (until === null || record.startedAt < until),
      )
      .map(([sid]) => sid);
    return Promise.resolve(
      parents.flatMap((parent) => [
        ...[...this.callRecords]
          .filter(([, record]) => record.parentCallSid === parent)
          .map(([sid]) => sid),
        parent,
      ]),
    );
  }

  deleteCall(callSid: string) {
    this.callRecords.delete(callSid);
    this.deletedCalls.push(callSid);
    return Promise.resolve();
  }

  listRecentRecordings({ since }: { since: Date }) {
    return Promise.resolve(this.recordings.filter((r) => r.createdAt >= since));
  }

  getCall(callSid: string) {
    return Promise.resolve(this.callDetails.get(callSid) ?? null);
  }

  deleteRecording(recordingSid: string) {
    this.deletedRecordings.push(recordingSid);
    return Promise.resolve();
  }

  fetchRecording(recordingUrl: string): Promise<RecordingAudio | null> {
    if (this.brokenRecordings.has(recordingUrl)) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.error(new Error("connection reset by the provider"));
        },
      });
      return Promise.resolve({ contentType: "audio/mpeg", body });
    }
    const bytes = this.recordingAudio.get(recordingUrl);
    if (!bytes) return Promise.resolve(null);
    return Promise.resolve({ contentType: "audio/mpeg", body: new Blob([bytes]).stream() });
  }

  verifyWebhook({ url, params, signature }: WebhookRequest): boolean {
    if (typeof signature !== "string") return false;
    const expected = this.sign(url, params);
    return (
      signature.length === expected.length &&
      timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    );
  }

  /** Signs a request as the provider would: a digest over the URL plus the sorted parameters. */
  sign(url: string, params: Record<string, string>): string {
    const data =
      url +
      Object.keys(params)
        .sort()
        .map((key) => key + params[key])
        .join("");
    return createHmac("sha1", this.signingKey).update(data).digest("base64");
  }
}
