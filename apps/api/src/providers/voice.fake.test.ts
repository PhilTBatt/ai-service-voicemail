import { describe, expect, it } from "vitest";
import { sampleAgentDefinition, sampleCallEndedEvent } from "../testing/agent-fixture.ts";
import { describeVoiceProviderContract } from "./voice.contract.ts";
import { FakeVoiceProvider } from "./voice.fake.ts";

describeVoiceProviderContract("Fake", () => {
  const provider = new FakeVoiceProvider();
  return {
    provider,
    signedWebhook: (event) => provider.webhookFor(event),
    ignorableWebhook: () => provider.webhookFor({ event: "call_started" }),
    seedRecording: (callId, bytes) => provider.recordingAudio.set(callId, bytes),
  };
});

describe("FakeVoiceProvider", () => {
  it("remembers what it was asked to do, for assertions in other tests", async () => {
    const provider = new FakeVoiceProvider();
    const definition = sampleAgentDefinition();
    const { providerAgentId } = await provider.upsertAgent({
      definition,
      existingProviderAgentId: null,
    });
    const registration = { providerAgentId, from: null, to: "+441632960001", variables: {} };
    await provider.registerInboundCall(registration);
    await provider.deleteCallData("call_1");

    expect(provider.agents.get(providerAgentId)).toBe(definition);
    expect(provider.calls).toEqual([registration]);
    expect(provider.deleteCalls).toEqual(["call_1"]);
  });

  it("rejects a correctly signed body that isn't a webhook at all", () => {
    const provider = new FakeVoiceProvider();
    const { rawBody, headers } = provider.signedRequest(Buffer.from('{"nonsense":true}'));
    expect(() => provider.verifyAndParseWebhook(rawBody, headers)).toThrow(/Malformed/);
    void sampleCallEndedEvent;
  });
});
