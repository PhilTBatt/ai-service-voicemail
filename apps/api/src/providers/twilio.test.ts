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
