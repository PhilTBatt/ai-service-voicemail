// The Twilio adapter's side of voicemail transcription (decision 022), against the stubbed Batch
// Transcription API: the one configuration it keeps, the request it sends, the result it reads.
// What the stub answers is Twilio's documented shape; the real API is unverified until the
// switch is first turned on (RUNBOOK section 18).
import { createHash } from "node:crypto";
import twilio from "twilio";
import { describe, expect, it } from "vitest";
import { TwilioApiStub } from "../testing/twilio-stub.ts";
import {
  TRANSCRIPTION_CONFIGURATION_NAME,
  TwilioTelephonyProvider,
  transcriptionConfigurationBody,
} from "./twilio.ts";

const ACCOUNT_SID = "AC" + "0".repeat(32);
const AUTH_TOKEN = "not-a-real-token";
const RECORDING_SID = "RE" + "b".repeat(32);
const CALLBACK_URL = "https://callmate.example.com/webhooks/twilio/transcription";

function make() {
  const stub = new TwilioApiStub();
  const provider = new TwilioTelephonyProvider({
    accountSid: ACCOUNT_SID,
    authToken: AUTH_TOKEN,
    fetch: stub.fetch,
  });
  const voiceRequests = () =>
    stub.requests
      .filter((request) => request.path.startsWith("/v"))
      .map((request) => ({
        method: request.method,
        path: request.path,
        json: request.json,
      }));
  return { stub, provider, voiceRequests };
}

describe("TwilioTelephonyProvider.requestTranscription", () => {
  it("makes the configuration once, pointing results at our webhook, then asks for the transcription", async () => {
    const { stub, provider, voiceRequests } = make();
    const { transcriptionRef } = await provider.requestTranscription({
      recordingSid: RECORDING_SID,
      callbackUrl: CALLBACK_URL,
    });
    expect(transcriptionRef).toBe("voice_transcription_stub1");
    expect(voiceRequests()).toEqual([
      { method: "GET", path: "/v2/Configurations/Transcription", json: undefined },
      {
        method: "POST",
        path: "/v2/Configurations/Transcription",
        json: transcriptionConfigurationBody(CALLBACK_URL),
      },
      {
        method: "POST",
        path: "/v3/Transcriptions",
        json: {
          transcriptionConfigurationId: "voice_transcriptionconfiguration_stub1",
          inputSource: "SOURCE_ID",
          sourceId: RECORDING_SID,
        },
      },
    ]);
    // The configuration: British English on Deepgram's current model, results POSTed to us.
    expect(stub.transcriptionConfigurations[0]).toMatchObject({
      unique_name: TRANSCRIPTION_CONFIGURATION_NAME,
      configuration: {
        configurationType: "Transcription",
        transcriptionEngine: "deepgram",
        speechModel: "nova-3",
        language: "en-GB",
        transcriptionStatusCallback: { url: CALLBACK_URL, method: "POST" },
      },
    });

    // The second voicemail: the configuration is remembered, so one request.
    await provider.requestTranscription({
      recordingSid: "RE" + "c".repeat(32),
      callbackUrl: CALLBACK_URL,
    });
    expect(voiceRequests().slice(3)).toEqual([
      { method: "POST", path: "/v3/Transcriptions", json: expect.any(Object) as unknown },
    ]);
    expect(stub.transcriptions).toHaveLength(2);
  });

  it("finds the configuration another process made, whatever Twilio calls the list", async () => {
    for (const listKey of ["configurations", "items", "data"]) {
      const { stub, provider, voiceRequests } = make();
      stub.configurationsListKey = listKey;
      stub.transcriptionConfigurations.push({
        id: "voice_transcriptionconfiguration_existing",
        unique_name: TRANSCRIPTION_CONFIGURATION_NAME,
        configuration: transcriptionConfigurationBody(CALLBACK_URL).configuration,
      });
      await provider.requestTranscription({
        recordingSid: RECORDING_SID,
        callbackUrl: CALLBACK_URL,
      });
      expect(
        voiceRequests().map((request) => `${request.method} ${request.path}`),
        listKey,
      ).toEqual(["GET /v2/Configurations/Transcription", "POST /v3/Transcriptions"]);
      expect(stub.transcriptions[0]?.body.transcriptionConfigurationId).toBe(
        "voice_transcriptionconfiguration_existing",
      );
    }
  });

  // After the domain move the API answers at a new address: results must follow it.
  it("updates a configuration whose webhook points at the API's old address", async () => {
    const { stub, provider, voiceRequests } = make();
    stub.transcriptionConfigurations.push({
      id: "voice_transcriptionconfiguration_existing",
      unique_name: TRANSCRIPTION_CONFIGURATION_NAME,
      configuration: transcriptionConfigurationBody(
        "https://callmate-api.old.example/webhooks/twilio/transcription",
      ).configuration,
    });
    await provider.requestTranscription({ recordingSid: RECORDING_SID, callbackUrl: CALLBACK_URL });
    expect(voiceRequests().map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /v2/Configurations/Transcription",
      "PUT /v2/Configurations/Transcription/voice_transcriptionconfiguration_existing",
      "POST /v3/Transcriptions",
    ]);
    expect(stub.transcriptionConfigurations[0]?.configuration).toMatchObject({
      transcriptionStatusCallback: { url: CALLBACK_URL, method: "POST" },
    });
  });

  it("fails with Twilio's answer when the request is refused, naming no words", async () => {
    const { provider } = make();
    const refusing = new TwilioTelephonyProvider({
      accountSid: ACCOUNT_SID,
      authToken: AUTH_TOKEN,
      fetch: () =>
        Promise.resolve(Response.json({ code: 20003, message: "Authenticate" }, { status: 401 })),
    });
    await expect(
      refusing.requestTranscription({ recordingSid: RECORDING_SID, callbackUrl: CALLBACK_URL }),
    ).rejects.toThrow(/Twilio .*Transcription.* failed: HTTP 401/);
    void provider;
  });
});

describe("TwilioTelephonyProvider.parseTranscriptionCallback", () => {
  const { provider } = make();

  it("reads the status in either case, and treats an unfinished one as pending", () => {
    expect(
      provider.parseTranscriptionCallback({
        id: "t",
        status: "COMPLETED",
        sentences: [{ text: "Hi" }],
      }),
    ).toMatchObject({
      status: "completed",
      text: "Hi",
    });
    expect(provider.parseTranscriptionCallback({ id: "t", status: "RUNNING" })).toMatchObject({
      status: "pending",
      text: null,
    });
    expect(provider.parseTranscriptionCallback({ id: "t", status: "canceled" })).toMatchObject({
      status: "failed",
    });
  });

  it("joins the sentences in order and skips empty ones; a completed result with none has no text", () => {
    expect(
      provider.parseTranscriptionCallback({
        id: "t",
        status: "completed",
        sentences: [{ text: " One. " }, { text: "" }, { text: "Two." }],
      }).text,
    ).toBe("One. Two.");
    expect(
      provider.parseTranscriptionCallback({ id: "t", status: "completed", sentences: [] }).text,
    ).toBeNull();
  });

  it("gives a failure its code and message, redacted", () => {
    const failed = provider.parseTranscriptionCallback({
      id: "t",
      status: "failed",
      error: { code: 32011, message: "Could not fetch recording for 07700 900123" },
    });
    expect(failed.error).toContain("32011");
    expect(failed.error).not.toContain("07700 900123");
  });
});

describe("TwilioTelephonyProvider.verifyJsonWebhook", () => {
  const { provider } = make();
  const body = JSON.stringify({ id: "t", status: "completed" });
  const hash = createHash("sha256").update(body).digest("hex");

  it("checks the signature over the URL with bodySHA256 and the body against that hash", () => {
    const url = `${CALLBACK_URL}?bodySHA256=${hash}`;
    const signature = twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, {});
    expect(provider.verifyJsonWebhook({ url, rawBody: Buffer.from(body), signature })).toBe(true);
    expect(provider.verifyJsonWebhook({ url, rawBody: Buffer.from(`${body} `), signature })).toBe(
      false,
    );
  });

  it("refuses a URL with no bodySHA256: nothing would tie the signature to the bytes", () => {
    const signature = twilio.getExpectedTwilioSignature(AUTH_TOKEN, CALLBACK_URL, {});
    expect(
      provider.verifyJsonWebhook({ url: CALLBACK_URL, rawBody: Buffer.from(body), signature }),
    ).toBe(false);
  });
});
