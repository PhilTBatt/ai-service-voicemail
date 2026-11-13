import { describe, expect, it } from "vitest";
import {
  PurchaseNotAllowedError,
  TranscriptionCallbackError,
  type TelephonyProvider,
} from "./telephony.ts";

export interface TelephonyHarness {
  /** A provider that is allowed to buy numbers. */
  provider: TelephonyProvider;
  /** The same provider configured with purchases disabled. */
  providerWithoutPurchases: TelephonyProvider;
  /** Signs a request as the provider would, for the webhook tests. */
  sign: (url: string, params: Record<string, string>) => string;
  /**
   * Signs a JSON webhook as the provider would, giving back the URL it would actually call
   * (Twilio adds a bodySHA256 parameter) and the signature.
   */
  signJson: (url: string, rawBody: string) => { url: string; signature: string };
  /** Puts a recording's audio at the "provider" under this URL. */
  seedRecording: (recordingUrl: string, bytes: Uint8Array<ArrayBuffer>) => void;
  /** Puts a call record at the "provider". */
  seedCallRecord: (record: {
    sid: string;
    to: string;
    startedAt: Date;
    parentCallSid: string | null;
  }) => void;
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

    it("quotes a monthly rental for local numbers", async () => {
      const { provider } = makeHarness();
      const prices = await provider.numberPrices();
      const local = prices.find((p) => p.type === "local");
      expect(local).toBeDefined();
      expect(Number(local!.monthly)).toBeGreaterThan(0);
      expect(local!.currency).toMatch(/^[A-Z]{3}$/);
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

    it("lists a number's call records between two dates, children first, and deletes them, safely twice", async () => {
      const { provider, seedCallRecord } = makeHarness();
      const to = "+441632960500";
      seedCallRecord({
        sid: "CAparent1",
        to,
        startedAt: new Date("2026-11-01T10:00:00Z"),
        parentCallSid: null,
      });
      seedCallRecord({
        sid: "CAchild1",
        to: "sip:agent@sip.example.com",
        startedAt: new Date("2026-11-01T10:00:01Z"),
        parentCallSid: "CAparent1",
      });
      seedCallRecord({
        sid: "CAold",
        to,
        startedAt: new Date("2026-09-01T10:00:00Z"),
        parentCallSid: null,
      });
      seedCallRecord({
        sid: "CAelsewhere",
        to: "+441632960501",
        startedAt: new Date("2026-11-01T10:00:00Z"),
        parentCallSid: null,
      });
      // After the number was released: whoever holds it next.
      seedCallRecord({
        sid: "CAnextHolder",
        to,
        startedAt: new Date("2026-11-05T10:00:00Z"),
        parentCallSid: null,
      });
      const since = new Date("2026-10-15T00:00:00Z");
      const until = new Date("2026-11-03T12:00:00Z");

      const sids = await provider.listCallSids({ to, since, until });
      expect(sids).toEqual(["CAchild1", "CAparent1"]);
      for (const sid of sids) await provider.deleteCall(sid);
      await expect(provider.deleteCall("CAparent1")).resolves.toBeUndefined();
      expect(await provider.listCallSids({ to, since, until })).toEqual([]);
      expect(await provider.listCallSids({ to, since, until: null })).toEqual(["CAnextHolder"]);
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

    // Voicemail transcription (decision 022): asked for, and the result read and checked.
    describe("transcription", () => {
      const RECORDING_SID = "RE" + "a".repeat(32);
      const CALLBACK_URL = "https://example.com/webhooks/twilio/transcription";

      it("asks for a recording's transcription and gives back a reference to match the result by", async () => {
        const { provider } = makeHarness();
        const first = await provider.requestTranscription({
          recordingSid: RECORDING_SID,
          callbackUrl: CALLBACK_URL,
        });
        expect(first.transcriptionRef).toMatch(/\S/);
        // Safe to repeat for the same recording: a reference again, and nothing thrown.
        const again = await provider.requestTranscription({
          recordingSid: RECORDING_SID,
          callbackUrl: CALLBACK_URL,
        });
        expect(again.transcriptionRef).toMatch(/\S/);
      });

      it("reads a completed result's words in order, a failed one's reason, and refuses one it can't read", () => {
        const { provider } = makeHarness();
        const done = provider.parseTranscriptionCallback({
          id: "tr_1",
          status: "completed",
          sourceId: RECORDING_SID,
          duration: 42,
          sentences: [
            { text: "Hi, it's Sam.", confidence: 0.9 },
            { text: "The boiler's gone.", confidence: 0.8 },
          ],
        });
        expect(done).toMatchObject({
          transcriptionRef: "tr_1",
          recordingSid: RECORDING_SID,
          status: "completed",
          text: "Hi, it's Sam. The boiler's gone.",
          durationSeconds: 42,
          error: null,
        });
        expect(done.confidence).toBeCloseTo(0.85);

        const failed = provider.parseTranscriptionCallback({
          id: "tr_2",
          status: "failed",
          error: { message: "media too short" },
        });
        expect(failed).toMatchObject({ transcriptionRef: "tr_2", status: "failed", text: null });
        expect(failed.error).toContain("media too short");

        expect(() => provider.parseTranscriptionCallback({ nonsense: true })).toThrow(
          TranscriptionCallbackError,
        );
        expect(() => provider.parseTranscriptionCallback("words")).toThrow(
          TranscriptionCallbackError,
        );
      });

      it("accepts a JSON webhook signed for exactly these bytes and this URL, and refuses any other", () => {
        const { provider, signJson } = makeHarness();
        const body = JSON.stringify({ id: "tr_1", status: "completed", sentences: [] });
        const { url, signature } = signJson(CALLBACK_URL, body);
        const rawBody = Buffer.from(body);
        expect(provider.verifyJsonWebhook({ url, rawBody, signature })).toBe(true);
        expect(
          provider.verifyJsonWebhook({
            url,
            rawBody: Buffer.from(body.replace("completed", "failed")),
            signature,
          }),
        ).toBe(false);
        expect(
          provider.verifyJsonWebhook({
            url: url.replace("example.com", "evil.example"),
            rawBody,
            signature,
          }),
        ).toBe(false);
        expect(provider.verifyJsonWebhook({ url, rawBody, signature: undefined })).toBe(false);
        expect(provider.verifyJsonWebhook({ url, rawBody, signature: "nope" })).toBe(false);
      });
    });
  });
}
