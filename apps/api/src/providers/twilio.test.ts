import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import twilio from "twilio";
import { TwilioApiStub } from "../testing/twilio-stub.ts";
import { describeTelephonyProviderContract } from "./telephony.contract.ts";
import { TwilioTelephonyProvider } from "./twilio.ts";

// A fake account: Twilio SIDs are "AC" + 32 hex characters.
const ACCOUNT_SID = "AC" + "0".repeat(32);
const AUTH_TOKEN = "not-a-real-token";

function makeHarness() {
  const stub = new TwilioApiStub();
  const make = (purchasesEnabled: boolean) =>
    new TwilioTelephonyProvider({
      accountSid: ACCOUNT_SID,
      authToken: AUTH_TOKEN,
      purchasesEnabled,
      bundleSid: "BU" + "1".repeat(32),
      addressSid: "AD" + "2".repeat(32),
      fetch: stub.fetch,
    });
  return {
    stub,
    provider: make(true),
    providerWithoutPurchases: make(false),
    sign: (url: string, params: Record<string, string>) =>
      twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params),
    // Twilio signs a JSON POST over the URL with a bodySHA256 parameter it adds, and no form
    // parameters (its SDK's validateRequestWithBody is the check).
    signJson: (url: string, rawBody: string) => {
      const hash = createHash("sha256").update(rawBody).digest("hex");
      const signed = `${url}${url.includes("?") ? "&" : "?"}bodySHA256=${hash}`;
      return { url: signed, signature: twilio.getExpectedTwilioSignature(AUTH_TOKEN, signed, {}) };
    },
    seedRecording: (url: string, bytes: Uint8Array<ArrayBuffer>) =>
      stub.recordingAudio.set(url.slice(url.lastIndexOf("/") + 1), bytes),
    seedCallRecord: (record: {
      sid: string;
      to: string;
      startedAt: Date;
      parentCallSid: string | null;
    }) =>
      stub.callRecords.push({
        sid: record.sid,
        to: record.to,
        // RFC 2822 in UTC, as Twilio sends it: "Fri, 18 Oct 2019 17:02:00 +0000".
        start_time: record.startedAt.toUTCString().replace("GMT", "+0000"),
        parent_call_sid: record.parentCallSid,
      }),
  };
}

describeTelephonyProviderContract("Twilio (stubbed API)", makeHarness);

describe("TwilioTelephonyProvider", () => {
  it("searches UK local numbers that can take voice calls", async () => {
    const { provider, stub } = makeHarness();
    await provider.searchNumbers({ contains: "0113", limit: 5 });
    expect(stub.requests[0]).toMatchObject({
      method: "GET",
      path: `/2010-04-01/Accounts/${ACCOUNT_SID}/AvailablePhoneNumbers/GB/Local.json`,
      query: { VoiceEnabled: "true", Contains: "0113", PageSize: "5" },
    });
  });

  it("buys with the webhook URLs and the UK regulatory bundle and address", async () => {
    const { provider, stub } = makeHarness();
    await provider.purchaseNumber(
      "+441134960100",
      {
        voiceUrl: "https://example.com/voice",
        voiceFallbackUrl: "https://example.com/fallback",
        friendlyName: "Test",
      },
      { live: true },
    );
    expect(stub.requests[0]).toMatchObject({
      method: "POST",
      path: `/2010-04-01/Accounts/${ACCOUNT_SID}/IncomingPhoneNumbers.json`,
      form: {
        PhoneNumber: "+441134960100",
        VoiceUrl: "https://example.com/voice",
        VoiceMethod: "POST",
        VoiceFallbackUrl: "https://example.com/fallback",
        VoiceFallbackMethod: "POST",
        FriendlyName: "Test",
        BundleSid: "BU" + "1".repeat(32),
        AddressSid: "AD" + "2".repeat(32),
      },
    });
  });

  it("makes no request at all when a purchase is refused", async () => {
    const { providerWithoutPurchases, stub } = makeHarness();
    await expect(
      providerWithoutPurchases.purchaseNumber(
        "+441134960100",
        { voiceUrl: "https://example.com/voice", voiceFallbackUrl: "https://example.com/fallback" },
        { live: true },
      ),
    ).rejects.toThrow(/TWILIO_PURCHASES_ENABLED/);
    expect(stub.requests).toEqual([]);
  });

  it("sends Basic auth with the account SID and auth token", async () => {
    const stub = new TwilioApiStub();
    let authHeader: string | undefined;
    const spyingFetch: typeof fetch = (input, init) => {
      authHeader = (init?.headers as Record<string, string> | undefined)?.Authorization;
      return stub.fetch(input, init);
    };
    const provider = new TwilioTelephonyProvider({
      accountSid: ACCOUNT_SID,
      authToken: AUTH_TOKEN,
      fetch: spyingFetch,
    });
    await provider.searchNumbers({});
    expect(authHeader).toBe(
      `Basic ${Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString("base64")}`,
    );
  });
});

describe("TwilioTelephonyProvider recordings", () => {
  it("lists finished recordings created since a point in time, trimmed to the exact instant", async () => {
    const { provider, stub } = makeHarness();
    stub.recordings.push(
      {
        sid: "RE1",
        call_sid: "CA1",
        uri: "/2010-04-01/Accounts/AC0/Recordings/RE1.json",
        duration: "30",
        date_created: "Fri, 06 Nov 2026 19:30:00 +0000",
        status: "completed",
      },
      {
        sid: "RE2",
        call_sid: "CA2",
        uri: "/2010-04-01/Accounts/AC0/Recordings/RE2.json",
        duration: "12",
        date_created: "Fri, 06 Nov 2026 17:00:00 +0000",
        status: "completed",
      },
      // Still being processed, and an empty one: neither is a voicemail yet.
      {
        sid: "RE3",
        call_sid: "CA3",
        uri: "/2010-04-01/Accounts/AC0/Recordings/RE3.json",
        duration: null,
        date_created: "Fri, 06 Nov 2026 19:40:00 +0000",
        status: "processing",
      },
      {
        sid: "RE4",
        call_sid: "CA4",
        uri: "/2010-04-01/Accounts/AC0/Recordings/RE4.json",
        duration: "0",
        date_created: "Fri, 06 Nov 2026 19:35:00 +0000",
        status: "absent",
      },
    );
    const since = new Date("2026-11-06T18:00:00Z");
    expect(await provider.listRecentRecordings({ since })).toEqual([
      {
        recordingSid: "RE1",
        callSid: "CA1",
        url: "https://api.twilio.com/2010-04-01/Accounts/AC0/Recordings/RE1",
        durationSeconds: 30,
        createdAt: new Date("2026-11-06T19:30:00Z"),
      },
    ]);
    expect(stub.requests[0]).toMatchObject({
      query: { "DateCreated>": "2026-11-05", PageSize: "100" },
    });
  });

  it("fetches a call's numbers and times, treating a withheld caller as null", async () => {
    const { provider, stub } = makeHarness();
    stub.calls.set("CA1", {
      sid: "CA1",
      from: "anonymous",
      to: "+441134960100",
      start_time: "Fri, 06 Nov 2026 19:29:00 +0000",
      end_time: "Fri, 06 Nov 2026 19:30:00 +0000",
      duration: "60",
    });
    expect(await provider.getCall("CA1")).toEqual({
      callSid: "CA1",
      from: null,
      to: "+441134960100",
      startedAt: new Date("2026-11-06T19:29:00Z"),
      endedAt: new Date("2026-11-06T19:30:00Z"),
      durationSeconds: 60,
    });
    expect(await provider.getCall("CA_unknown")).toBeNull();
  });
});

describe("TwilioTelephonyProvider recording URLs", () => {
  it("refuses to send the account credentials anywhere but Twilio", async () => {
    const { provider } = makeHarness();
    await expect(
      provider.fetchRecording("https://evil.example/2010-04-01/Accounts/AC0/Recordings/RE1"),
    ).rejects.toThrow(/non-Twilio/);
  });
});

describe("TwilioTelephonyProvider recording pages", () => {
  it("follows next_page_uri until the pages reach back past the window", async () => {
    const { provider, stub } = makeHarness();
    stub.recordingsPageSize = 2;
    const at = (minutesAgo: number) =>
      new Date(Date.parse("2026-11-06T20:00:00Z") - minutesAgo * 60_000).toUTCString();
    for (const [i, minutesAgo] of [5, 10, 20, 2000].entries()) {
      stub.recordings.push({
        sid: `RE${i}`,
        call_sid: `CA${i}`,
        uri: `/2010-04-01/Accounts/AC0/Recordings/RE${i}.json`,
        duration: "30",
        date_created: at(minutesAgo),
        status: "completed",
      });
    }
    const since = new Date(Date.parse("2026-11-06T20:00:00Z") - 60 * 60_000);
    const listed = await provider.listRecentRecordings({ since });
    expect(listed.map((r) => r.recordingSid)).toEqual(["RE0", "RE1", "RE2"]);
    // Two pages were needed; the third (older than the window) was never fetched.
    expect(stub.requests.filter((r) => r.path.endsWith("/Recordings.json"))).toHaveLength(2);
  });
});

describe("TwilioTelephonyProvider number settings", () => {
  it("sends the SMS webhook alongside the voice ones when configuring a number", async () => {
    const { provider, stub } = makeHarness();
    const [first] = await provider.searchNumbers({ limit: 1 });
    const bought = await provider.purchaseNumber(
      first!.number,
      {
        voiceUrl: "https://example.com/webhooks/twilio/voice",
        voiceFallbackUrl: "https://example.com/fallback",
        smsUrl: "https://example.com/webhooks/twilio/sms",
      },
      { live: true },
    );
    await provider.configureNumber(bought.providerSid, {
      voiceUrl: "https://example.com/v2",
      voiceFallbackUrl: "https://example.com/fallback",
      smsUrl: "https://example.com/webhooks/twilio/sms",
    });
    const configure = stub.requests.at(-1)!;
    expect(configure.form).toMatchObject({
      VoiceUrl: "https://example.com/v2",
      SmsUrl: "https://example.com/webhooks/twilio/sms",
      SmsMethod: "POST",
    });
  });
});

describe("TwilioTelephonyProvider prices", () => {
  it("reads the monthly rental per kind of UK number in the account's currency", async () => {
    const { provider } = makeHarness();
    expect(await provider.numberPrices()).toEqual([
      { type: "local", monthly: "0.86917", currency: "GBP" },
      { type: "mobile", monthly: "1.8895", currency: "GBP" },
      { type: "toll free", monthly: "2.04066", currency: "GBP" },
    ]);
  });
});
