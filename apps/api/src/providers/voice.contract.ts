import { describe, expect, it } from "vitest";
import { sampleAgentDefinition, sampleCallEndedEvent } from "../testing/agent-fixture.ts";
import {
  WebhookVerificationError,
  type CallEndedEvent,
  type FunctionCallEvent,
  type VoiceProvider,
  type WebhookHeaders,
} from "./voice.ts";

export interface VoiceProviderHarness {
  provider: VoiceProvider;
  /** A webhook for `event`, signed as the platform would sign it. */
  signedWebhook: (event: CallEndedEvent) => { rawBody: Buffer; headers: WebhookHeaders };
  /** A genuine, correctly signed webhook for an event we don't act on. */
  ignorableWebhook: () => { rawBody: Buffer; headers: WebhookHeaders };
  /** A mid-call function request for `event`, signed as the platform would. Absent for the live run. */
  signedFunctionCall?: (event: FunctionCallEvent) => { rawBody: Buffer; headers: WebhookHeaders };
  /** Makes the "platform" report this call as ended. Absent for the live run. */
  seedEndedCall?: (event: CallEndedEvent) => void;
  /** Puts a recording at the "platform" for a call. Absent for the live run. */
  seedRecording?: (providerCallId: string, bytes: Uint8Array<ArrayBuffer>) => void;
}

export interface ContractOptions {
  /** False for the live run: a registered call that's never dialled is just clutter. */
  canRegisterCalls?: boolean;
}

const FUNCTION_CALL: FunctionCallEvent = {
  type: "function_call",
  name: "gas_emergency_alert",
  providerCallId: "call_fixture_0002",
  providerAgentId: "fake_agent_1",
  dialledNumber: "+441632960001",
  callerNumber: "+447700900123",
};

const REGISTRATION = {
  from: "+447700900123",
  to: "+441632960001",
  variables: { open_now: "yes", holiday_mode: "no" },
};

/**
 * The behaviour every VoiceProvider must have. Runs against the fake in CI, and against the
 * real adapter when its env flag is set (so it never runs in CI by accident).
 */
export function describeVoiceProviderContract(
  name: string,
  makeHarness: () => VoiceProviderHarness,
  { canRegisterCalls = true }: ContractOptions = {},
) {
  describe(`${name} VoiceProvider contract`, () => {
    it("creates an agent and returns the platform's ID", async () => {
      const { provider } = makeHarness();
      const { providerAgentId } = await provider.upsertAgent({
        definition: sampleAgentDefinition(),
        existingProviderAgentId: null,
      });
      expect(providerAgentId).toEqual(expect.any(String));
      expect(providerAgentId).not.toBe("");
    });

    it("updates an existing agent in place rather than creating another", async () => {
      const { provider } = makeHarness();
      const first = await provider.upsertAgent({
        definition: sampleAgentDefinition({ profileVersion: 1 }),
        existingProviderAgentId: null,
      });
      const second = await provider.upsertAgent({
        definition: sampleAgentDefinition({ profileVersion: 2 }),
        existingProviderAgentId: first.providerAgentId,
      });
      expect(second.providerAgentId).toBe(first.providerAgentId);
    });

    it.skipIf(!canRegisterCalls)(
      "registers an inbound call for a known agent and returns a SIP URI",
      async () => {
        const { provider } = makeHarness();
        const { providerAgentId } = await provider.upsertAgent({
          definition: sampleAgentDefinition(),
          existingProviderAgentId: null,
        });
        const { sipUri } = await provider.registerInboundCall({ providerAgentId, ...REGISTRATION });
        expect(sipUri).toMatch(/^sip:[^@]+@[^@]+$/);
      },
    );

    it.skipIf(!canRegisterCalls)(
      "refuses to register a call for an agent it doesn't know",
      async () => {
        const { provider } = makeHarness();
        await expect(
          provider.registerInboundCall({ providerAgentId: "no_such_agent", ...REGISTRATION }),
        ).rejects.toThrow();
      },
    );

    it("parses a correctly signed call-ended webhook into the normalised event", () => {
      const harness = makeHarness();
      const event = sampleCallEndedEvent();
      const { rawBody, headers } = harness.signedWebhook(event);
      // Cost units are the platform's own, so they're checked in each adapter's tests.
      const facts: Partial<CallEndedEvent> = { ...event };
      delete facts.costs;
      const parsed = harness.provider.verifyAndParseWebhook(rawBody, headers);
      expect(parsed).toMatchObject(facts);
      expect(parsed).toHaveProperty("costs", expect.any(Array));
    });

    it("reports a genuine webhook for another event as ignored", () => {
      const harness = makeHarness();
      const { rawBody, headers } = harness.ignorableWebhook();
      expect(harness.provider.verifyAndParseWebhook(rawBody, headers)).toMatchObject({
        type: "ignored",
      });
    });

    it("rejects a webhook with a bad signature", () => {
      const harness = makeHarness();
      const { rawBody, headers } = harness.signedWebhook(sampleCallEndedEvent());
      const forged = Object.fromEntries(
        Object.entries(headers).map(([k, v]) => [
          k,
          typeof v === "string" ? v.replace(/./, "x") : v,
        ]),
      );
      expect(() => harness.provider.verifyAndParseWebhook(rawBody, forged)).toThrow(
        WebhookVerificationError,
      );
    });

    it("rejects a webhook whose body was changed after signing", () => {
      const harness = makeHarness();
      const { rawBody, headers } = harness.signedWebhook(sampleCallEndedEvent());
      const tampered = Buffer.from(
        rawBody.toString("utf8").replace("+447700900123", "+447700900999"),
      );
      expect(() => harness.provider.verifyAndParseWebhook(tampered, headers)).toThrow(
        WebhookVerificationError,
      );
    });

    it("parses a correctly signed mid-call function request, and rejects a tampered one", () => {
      const harness = makeHarness();
      if (!harness.signedFunctionCall) return; // live platform: it would have to ring us
      const { rawBody, headers } = harness.signedFunctionCall(FUNCTION_CALL);
      expect(harness.provider.verifyAndParseFunctionCall(rawBody, headers)).toEqual(FUNCTION_CALL);
      const tampered = Buffer.from(
        rawBody.toString("utf8").replace("+447700900123", "+447700900999"),
      );
      expect(() => harness.provider.verifyAndParseFunctionCall(tampered, headers)).toThrow(
        WebhookVerificationError,
      );
    });

    it("streams a call's recording, and returns null once the call's data is deleted", async () => {
      const harness = makeHarness();
      if (!harness.seedRecording) return; // live platform: nothing to seed
      harness.seedRecording("call_contract_recording", new Uint8Array([7, 8, 9]));
      const audio = await harness.provider.fetchRecording("call_contract_recording");
      expect(audio?.contentType).toContain("audio/");
      expect(new Uint8Array(await new Response(audio!.body).arrayBuffer())).toEqual(
        new Uint8Array([7, 8, 9]),
      );
      await harness.provider.deleteCallData("call_contract_recording");
      expect(await harness.provider.fetchRecording("call_contract_recording")).toBeNull();
      expect(await harness.provider.fetchRecording("call_never_existed")).toBeNull();
    });

    it("lists calls that ended since a point in time, as webhook events", async () => {
      const harness = makeHarness();
      const since = new Date("2026-11-06T00:00:00Z");
      if (harness.seedEndedCall) {
        harness.seedEndedCall(sampleCallEndedEvent({ providerCallId: "call_contract_listed" }));
      }
      const calls = await harness.provider.listEndedCalls({ since });
      expect(Array.isArray(calls)).toBe(true);
      if (harness.seedEndedCall) {
        const facts: Partial<CallEndedEvent> = sampleCallEndedEvent({
          providerCallId: "call_contract_listed",
        });
        delete facts.costs;
        expect(calls).toContainEqual(expect.objectContaining(facts));
      }
    });

    it("deletes an agent for good, and doesn't mind being asked twice", async () => {
      const { provider } = makeHarness();
      const { providerAgentId } = await provider.upsertAgent({
        definition: sampleAgentDefinition(),
        existingProviderAgentId: null,
      });
      await provider.deleteAgent(providerAgentId);
      await expect(provider.deleteAgent(providerAgentId)).resolves.toBeUndefined();
      // Gone: syncing against the old ID makes a new agent instead of updating that one.
      const again = await provider.upsertAgent({
        definition: sampleAgentDefinition(),
        existingProviderAgentId: providerAgentId,
      });
      expect(again.providerAgentId).not.toBe(providerAgentId);
      await provider.deleteAgent(again.providerAgentId);
    });

    it("deletes call data without error, even when asked twice", async () => {
      const { provider } = makeHarness();
      await provider.deleteCallData("call_contract_delete");
      await expect(provider.deleteCallData("call_contract_delete")).resolves.toBeUndefined();
    });
  });
}
