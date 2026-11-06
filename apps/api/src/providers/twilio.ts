// The Twilio adapter. Numbers are managed through Twilio's REST API with fetch (testable
// offline, like the Retell adapter); webhook signatures are checked with Twilio's own SDK,
// which Twilio says to use rather than reimplementing the scheme.
import twilio from "twilio";
import {
  PurchaseNotAllowedError,
  type AvailableNumber,
  type NumberConfiguration,
  type NumberSearch,
  type PurchasedNumber,
  type TelephonyProvider,
  type WebhookRequest,
} from "./telephony.ts";

export interface TwilioOptions {
  accountSid: string;
  authToken: string;
  /** Off by default: only a deliberately configured environment can spend money. */
  purchasesEnabled?: boolean;
  /** UK numbers need an approved regulatory bundle and address (Phil submits them under PhilCo). */
  bundleSid?: string;
  addressSid?: string;
  /** Injected by tests. */
  fetch?: typeof fetch;
}

export class TwilioApiError extends Error {
  override readonly name = "TwilioApiError";
  readonly status: number;

  constructor(status: number, path: string, detail: string) {
    super(`Twilio ${path} failed: HTTP ${status} ${detail}`);
    this.status = status;
  }
}

interface AvailableNumberJson {
  phone_number: string;
  locality: string | null;
  region: string | null;
}

export class TwilioTelephonyProvider implements TelephonyProvider {
  private readonly options: TwilioOptions;
  private readonly baseUrl: string;

  constructor(options: TwilioOptions) {
    this.options = options;
    this.baseUrl = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(options.accountSid)}`;
  }

  async searchNumbers({ contains, limit = 10 }: NumberSearch): Promise<AvailableNumber[]> {
    const query = new URLSearchParams({ VoiceEnabled: "true", PageSize: String(limit) });
    if (contains) query.set("Contains", contains);
    const result = await this.request<{ available_phone_numbers: AvailableNumberJson[] }>(
      "GET",
      `/AvailablePhoneNumbers/GB/Local.json?${query}`,
    );
    return result.available_phone_numbers.map((n) => ({
      number: n.phone_number,
      locality: n.locality,
      region: n.region,
    }));
  }

  async purchaseNumber(
    number: string,
    config: NumberConfiguration,
    { live }: { live: boolean },
  ): Promise<PurchasedNumber> {
    if (!this.options.purchasesEnabled || !live) {
      throw new PurchaseNotAllowedError(
        "Buying a number needs TWILIO_PURCHASES_ENABLED=true and an explicit live: true",
      );
    }
    const created = await this.request<{ sid: string; phone_number: string }>(
      "POST",
      "/IncomingPhoneNumbers.json",
      {
        PhoneNumber: number,
        ...numberForm(config),
        ...(this.options.bundleSid !== undefined && { BundleSid: this.options.bundleSid }),
        ...(this.options.addressSid !== undefined && { AddressSid: this.options.addressSid }),
      },
    );
    return { providerSid: created.sid, number: created.phone_number };
  }

  async configureNumber(providerSid: string, config: NumberConfiguration): Promise<void> {
    await this.request(
      "POST",
      `/IncomingPhoneNumbers/${encodeURIComponent(providerSid)}.json`,
      numberForm(config),
    );
  }

  async releaseNumber(providerSid: string): Promise<void> {
    try {
      await this.request("DELETE", `/IncomingPhoneNumbers/${encodeURIComponent(providerSid)}.json`);
    } catch (error) {
      // Already released: the outcome we wanted.
      if (!(error instanceof TwilioApiError && error.status === 404)) throw error;
    }
  }

  verifyWebhook({ url, params, signature }: WebhookRequest): boolean {
    if (typeof signature !== "string") return false;
    // HMAC-SHA1 over the exact public URL plus the sorted form parameters, keyed with the
    // auth token. Twilio's SDK keeps up with their parameter changes.
    return twilio.validateRequest(this.options.authToken, signature, url, params);
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    form?: Record<string, string>,
  ): Promise<T> {
    const credentials = Buffer.from(
      `${this.options.accountSid}:${this.options.authToken}`,
    ).toString("base64");
    const response = await (this.options.fetch ?? fetch)(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${credentials}`,
        ...(form && { "Content-Type": "application/x-www-form-urlencoded" }),
      },
      ...(form && { body: new URLSearchParams(form).toString() }),
    });
    if (!response.ok) {
      throw new TwilioApiError(response.status, path, (await response.text()).slice(0, 300));
    }
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  }
}

function numberForm(config: NumberConfiguration): Record<string, string> {
  return {
    VoiceUrl: config.voiceUrl,
    VoiceMethod: "POST",
    VoiceFallbackUrl: config.voiceFallbackUrl,
    VoiceFallbackMethod: "POST",
    ...(config.friendlyName !== undefined && { FriendlyName: config.friendlyName }),
  };
}
