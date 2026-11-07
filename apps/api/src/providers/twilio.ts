// The Twilio adapter. Numbers are managed through Twilio's REST API with fetch (testable
// offline, like the Retell adapter); webhook signatures are checked with Twilio's own SDK,
// which Twilio says to use rather than reimplementing the scheme.
import twilio from "twilio";
import {
  PurchaseNotAllowedError,
  type AvailableNumber,
  type CallDetails,
  type NumberConfiguration,
  type NumberPrice,
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

/** A call in Twilio's list, as much of it as deleting needs. */
interface ListedCall {
  sid: string;
  /** RFC 2822 in UTC, e.g. "Fri, 18 Oct 2019 17:02:00 +0000"; empty if it was never dialled. */
  start_time: string | null;
}

/**
 * Whether a listed call started before `until`. One that never started is kept: it was made to
 * the number within the range Twilio was asked for. A start time that can't be read stops the
 * deletion rather than risk deleting another business's record.
 */
function startedBefore(call: ListedCall, until: Date | null): boolean {
  if (!until || !call.start_time) return true;
  const started = new Date(call.start_time);
  if (Number.isNaN(started.getTime())) {
    throw new Error(`Twilio call ${call.sid} has a start_time we can't read: ${call.start_time}`);
  }
  return started < until;
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

  /** Twilio's pricing API lives on its own host, priced in the account's currency. */
  async numberPrices(): Promise<NumberPrice[]> {
    const credentials = Buffer.from(
      `${this.options.accountSid}:${this.options.authToken}`,
    ).toString("base64");
    const response = await (this.options.fetch ?? fetch)(
      "https://pricing.twilio.com/v1/PhoneNumbers/Countries/GB",
      { headers: { Authorization: `Basic ${credentials}` }, signal: AbortSignal.timeout(15_000) },
    );
    if (!response.ok) {
      throw new TwilioApiError(
        response.status,
        "/v1/PhoneNumbers/Countries/GB",
        (await response.text()).slice(0, 300),
      );
    }
    const body = (await response.json()) as {
      price_unit: string;
      phone_number_prices: { number_type: string; current_price: string }[];
    };
    return body.phone_number_prices
      .filter((p): p is { number_type: NumberPrice["type"]; current_price: string } =>
        ["local", "mobile", "national", "toll free"].includes(p.number_type),
      )
      .map((p) => ({ type: p.number_type, monthly: p.current_price, currency: body.price_unit }));
  }

  async listRecentRecordings({ since }: { since: Date }): Promise<RecordingSummary[]> {
    // Twilio filters by whole days ("DateCreated>" is on or after that date), so ask from the
    // day before and trim to the exact instant here.
    const dayBefore = new Date(since.getTime() - 24 * 3600_000).toISOString().slice(0, 10);
    const query = new URLSearchParams({ "DateCreated>": dayBefore, PageSize: "100" });
    const recordings: RecordingSummary[] = [];
    // Newest first, a page at a time: stop once a page reaches back past `since`.
    let path: string | null = `/Recordings.json?${query}`;
    while (path) {
      const result: { recordings: RecordingJson[]; next_page_uri: string | null } =
        await this.request("GET", path);
      const page = result.recordings.map((r) => ({
        recordingSid: r.sid,
        callSid: r.call_sid,
        url: `https://api.twilio.com${r.uri.replace(/\.json$/, "")}`,
        durationSeconds: Number(r.duration) || 0,
        createdAt: new Date(r.date_created),
      }));
      recordings.push(...page.filter((r) => r.createdAt >= since));
      const oldest = page.at(-1);
      path =
        result.next_page_uri && oldest && oldest.createdAt >= since
          ? result.next_page_uri.replace(/^\/2010-04-01\/Accounts\/[^/]+/, "")
          : null;
    }
    return recordings;
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

  // Twilio's docs (read 2026-11-07): GET /Calls.json filters by To, "StartTime>" (a UTC date,
  // on or after) and ParentCallSid, up to 1,000 a page with next_page_uri; each call's
  // start_time is RFC 2822 in UTC. The end of the range is checked here, on start_time. Calls
  // older than 13 months can't be read or deleted this way, only through Bulk Export.
  async listCallSids({
    to,
    since,
    until,
  }: {
    to: string;
    since: Date;
    until: Date | null;
  }): Promise<string[]> {
    const day = since.toISOString().slice(0, 10);
    const parents = (
      await this.callPages(
        `/Calls.json?${new URLSearchParams({ To: to, "StartTime>": day, PageSize: "1000" })}`,
      )
    ).filter((call) => startedBefore(call, until));
    const sids: string[] = [];
    for (const parent of parents) {
      // The leg that dialled the voice platform is its own record, spawned by this call.
      const children = await this.callPages(
        `/Calls.json?${new URLSearchParams({ ParentCallSid: parent.sid, PageSize: "1000" })}`,
      );
      sids.push(...children.map((call) => call.sid), parent.sid);
    }
    return sids;
  }

  private async callPages(firstPath: string): Promise<ListedCall[]> {
    const calls: ListedCall[] = [];
    let path: string | null = firstPath;
    while (path) {
      const result: { calls: ListedCall[]; next_page_uri: string | null } = await this.request(
        "GET",
        path,
      );
      calls.push(...result.calls);
      path = result.next_page_uri
        ? result.next_page_uri.replace(/^\/2010-04-01\/Accounts\/[^/]+/, "")
        : null;
    }
    return calls;
  }

  // "This will delete a call record from your account... but will not delete associated
  // recordings" (Twilio's docs). A record that's already gone is the outcome we wanted.
  async deleteCall(callSid: string): Promise<void> {
    try {
      await this.request("DELETE", `/Calls/${encodeURIComponent(callSid)}.json`);
    } catch (error) {
      if (!(error instanceof TwilioApiError && error.status === 404)) throw error;
    }
  }

  // The stored reference is the recording's resource URL; adding .mp3 asks for the audio.
  // Twilio recordings need the account's credentials, which is why the API streams them.
  async fetchRecording(recordingUrl: string): Promise<RecordingAudio | null> {
    // The reference comes from Twilio's own callbacks and API, but the credentials go in
    // the request, so never follow it anywhere else.
    if (new URL(recordingUrl).origin !== "https://api.twilio.com") {
      throw new Error("Refusing to send Twilio credentials to a non-Twilio recording URL");
    }
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
      signal: AbortSignal.timeout(15_000),
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
    ...(config.smsUrl !== undefined && { SmsUrl: config.smsUrl, SmsMethod: "POST" }),
    ...(config.friendlyName !== undefined && { FriendlyName: config.friendlyName }),
  };
}
