import { describe, expect, it } from "vitest";
import { PurchaseNotAllowedError, type TelephonyProvider } from "./telephony.ts";

export interface TelephonyHarness {
  /** A provider that is allowed to buy numbers. */
  provider: TelephonyProvider;
  /** The same provider configured with purchases disabled. */
  providerWithoutPurchases: TelephonyProvider;
  /** Signs a request as the provider would, for the webhook tests. */
  sign: (url: string, params: Record<string, string>) => string;
  /** Puts a recording's audio at the "provider" under this URL. */
  seedRecording: (recordingUrl: string, bytes: Uint8Array<ArrayBuffer>) => void;
}

const CONFIG = {
  voiceUrl: "https://example.com/webhooks/twilio/voice",
  voiceFallbackUrl: "https://example.com/fallback",
  friendlyName: "CallMate test",
};

/** The behaviour every TelephonyProvider must have. Runs against the fake and the stubbed Twilio adapter. */
export function describeTelephonyProviderContract(
  name: string,
  makeHarness: () => TelephonyHarness,
) {
  describe(`${name} TelephonyProvider contract`, () => {
    it("finds UK numbers in E.164 form", async () => {
      const { provider } = makeHarness();
      const numbers = await provider.searchNumbers({ contains: "0113", limit: 3 });
      expect(numbers.length).toBeGreaterThan(0);
      expect(numbers.length).toBeLessThanOrEqual(3);
      for (const n of numbers) expect(n.number).toMatch(/^\+44[1-9]\d{8,9}$/);
    });

    it("refuses to buy without live: true", async () => {
      const { provider } = makeHarness();
      const [first] = await provider.searchNumbers({ limit: 1 });
      await expect(provider.purchaseNumber(first!.number, CONFIG, { live: false })).rejects.toThrow(
        PurchaseNotAllowedError,
      );
    });

    it("refuses to buy when purchases are disabled, even with live: true", async () => {
      const { providerWithoutPurchases } = makeHarness();
      const [first] = await providerWithoutPurchases.searchNumbers({ limit: 1 });
      await expect(
        providerWithoutPurchases.purchaseNumber(first!.number, CONFIG, { live: true }),
      ).rejects.toThrow(PurchaseNotAllowedError);
    });

    it("buys, reconfigures and releases a number when both guards are satisfied", async () => {
      const { provider } = makeHarness();
      const [first] = await provider.searchNumbers({ limit: 1 });
      const bought = await provider.purchaseNumber(first!.number, CONFIG, { live: true });
      expect(bought).toEqual({ providerSid: expect.any(String) as unknown, number: first!.number });

      await expect(
        provider.configureNumber(bought.providerSid, {
          ...CONFIG,
          voiceUrl: "https://example.com/v2",
        }),
      ).resolves.toBeUndefined();
      await expect(provider.releaseNumber(bought.providerSid)).resolves.toBeUndefined();
      await expect(provider.releaseNumber(bought.providerSid)).resolves.toBeUndefined(); // repeatable
    });

    it("streams a recording's audio, and returns null for one it no longer has", async () => {
      const { provider, seedRecording } = makeHarness();
      const url = "https://api.twilio.com/2010-04-01/Accounts/AC0/Recordings/REcontract";
      seedRecording(url, new Uint8Array([1, 2, 3]));
      const audio = await provider.fetchRecording(url);
      expect(audio?.contentType).toContain("audio/mpeg");
      expect(new Uint8Array(await new Response(audio!.body).arrayBuffer())).toEqual(
        new Uint8Array([1, 2, 3]),
      );
      expect(await provider.fetchRecording(url + "_gone")).toBeNull();
    });

    describe("verifyWebhook", () => {
      const url = "https://example.com/webhooks/twilio/voice";
      const params = { CallSid: "CA123", From: "+447700900123", To: "+441134960100" };

      it("accepts a request signed for this URL and body", () => {
        const { provider, sign } = makeHarness();
        expect(provider.verifyWebhook({ url, params, signature: sign(url, params) })).toBe(true);
      });

      it("rejects a missing or wrong signature", () => {
        const { provider, sign } = makeHarness();
        expect(provider.verifyWebhook({ url, params, signature: undefined })).toBe(false);
        // A signature for different parameters is guaranteed to differ from the right one.
        expect(
          provider.verifyWebhook({ url, params, signature: sign(url, { ...params, Extra: "1" }) }),
        ).toBe(false);
      });

      it("rejects a body changed after signing", () => {
        const { provider, sign } = makeHarness();
        const signature = sign(url, params);
        expect(
          provider.verifyWebhook({ url, params: { ...params, From: "+447700900999" }, signature }),
        ).toBe(false);
      });

      it("rejects a signature made for a different URL (the public URL must match exactly)", () => {
        const { provider, sign } = makeHarness();
        const signature = sign("http://localhost:3000/webhooks/twilio/voice", params);
        expect(provider.verifyWebhook({ url, params, signature })).toBe(false);
      });
    });
  });
}
