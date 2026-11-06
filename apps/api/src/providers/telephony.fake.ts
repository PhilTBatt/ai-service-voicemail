import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  PurchaseNotAllowedError,
  type AvailableNumber,
  type CallDetails,
  type NumberConfiguration,
  type NumberSearch,
  type PurchasedNumber,
  type RecordingSummary,
  type TelephonyProvider,
  type WebhookRequest,
} from "./telephony.ts";

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
  private readonly purchasesEnabled: boolean;

  constructor({ purchasesEnabled = true }: { purchasesEnabled?: boolean } = {}) {
    this.purchasesEnabled = purchasesEnabled;
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
