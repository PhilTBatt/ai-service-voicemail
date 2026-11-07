// The Twilio adapter. Numbers are managed through Twilio's REST API with fetch (testable
// offline, like the Retell adapter); webhook signatures are checked with Twilio's own SDK,
// which Twilio says to use rather than reimplementing the scheme.
import twilio from "twilio";
import {
  PurchaseNotAllowedError,
  type AvailableNumber,
  type CallDetails,
  type NumberConfiguration,
  type NumberSearch,
  type PurchasedNumber,
  type RecordingAudio,
  type RecordingSummary,
  type TelephonyProvider,
  type WebhookRequest,
} from "./telephony.ts";
import { e164OrNull } from "../core/phone.ts";

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

interface RecordingJson {
  sid: string;
  call_sid: string;
  uri: string;
  duration: string | null;
  date_created: string;
}

interface CallJson {
  sid: string;
  from: string;
  to: string;
  start_time: string;
  end_time: string | null;
  duration: string | null;
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

  async listRecentRecordings({ since }: { since: Date }): Promise<RecordingSummary[]> {
    // Twilio filters by whole days ("DateCreated>" is on or after that date), so ask from the
    // day before and trim to the exact instant here.
    const dayBefore = new Date(since.getTime() - 24 * 3600_000).toISOString().slice(0, 10);
    const query = new URLSearchParams({ "DateCreated>": dayBefore, PageSize: "100" });
    const result = await this.request<{ recordings: RecordingJson[] }>(
      "GET",
      `/Recordings.json?${query}`,
    );
    return result.recordings
      .map((r) => ({
        recordingSid: r.sid,
        callSid: r.call_sid,
        url: `https://api.twilio.com${r.uri.replace(/\.json$/, "")}`,
        durationSeconds: Number(r.duration) || 0,
        createdAt: new Date(r.date_created),
      }))
      .filter((r) => r.createdAt >= since);
  }

  async getCall(callSid: string): Promise<CallDetails | null> {
    try {
      const call = await this.request<CallJson>(
        "GET",
        `/Calls/${encodeURIComponent(callSid)}.json`,
      );
      return {
        callSid: call.sid,
        from: e164OrNull(call.from),
        to: call.to,
        startedAt: new Date(call.start_time),
        endedAt: call.end_time ? new Date(call.end_time) : null,
        durationSeconds: Number(call.duration) || 0,
      };
    } catch (error) {
      if (error instanceof TwilioApiError && error.status === 404) return null;
      throw error;
    }
  }

  async deleteRecording(recordingSid: string): Promise<void> {
    try {
      await this.request("DELETE", `/Recordings/${encodeURIComponent(recordingSid)}.json`);
    } catch (error) {
      if (!(error instanceof TwilioApiError && error.status === 404)) throw error;
    }
  }

  // The stored reference is the recording's resource URL; adding .mp3 asks for the audio.
  // Twilio recordings need the account's credentials, which is why the API streams them.
  async fetchRecording(recordingUrl: string): Promise<RecordingAudio | null> {
    const credentials = Buffer.from(
      `${this.options.accountSid}:${this.options.authToken}`,
    ).toString("base64");
    const response = await (this.options.fetch ?? fetch)(`${recordingUrl}.mp3`, {
      headers: { Authorization: `Basic ${credentials}` },
    });
    if (response.status === 404) return null;
    if (!response.ok || !response.body) {
      throw new TwilioApiError(
        response.status,
        "/Recordings/*.mp3",
        (await response.text()).slice(0, 300),
      );
    }
    return {
      contentType: response.headers.get("content-type") ?? "audio/mpeg",
      body: response.body,
    };
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
