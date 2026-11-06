import { describe, expect, it } from "vitest";
import { sampleAgentDefinition, sampleCallEndedEvent } from "../testing/agent-fixture.ts";
import {
  WebhookVerificationError,
  type CallEndedEvent,
  type VoiceProvider,
  type WebhookHeaders,
} from "./voice.ts";

export interface VoiceProviderHarness {
  provider: VoiceProvider;
  /** A webhook for `event`, signed as the platform would sign it. */
  signedWebhook(event: CallEndedEvent): { rawBody: Buffer; headers: WebhookHeaders };
  /** A genuine, correctly signed webhook for an event we don't act on. */
  ignorableWebhook(): { rawBody: Buffer; headers: WebhookHeaders };
  /** An E.164 number the provider can attach to an agent. */
  attachableNumber: string;
}

/**
 * The behaviour every VoiceProvider must have. Runs against the fake in CI, and against the
 * real adapter when its env flag is set (so it never runs in CI by accident).
 */
export function describeVoiceProviderContract(
  name: string,
  makeHarness: () => VoiceProviderHarness,
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

    it("attaches a number to an agent it knows", async () => {
      const { provider, attachableNumber } = makeHarness();
      const { providerAgentId } = await provider.upsertAgent({
        definition: sampleAgentDefinition(),
        existingProviderAgentId: null,
      });
      await expect(
        provider.attachNumber(providerAgentId, attachableNumber),
      ).resolves.toBeUndefined();
    });

    it("refuses to attach a number to an agent it doesn't know", async () => {
      const { provider, attachableNumber } = makeHarness();
      await expect(provider.attachNumber("no_such_agent", attachableNumber)).rejects.toThrow();
    });

    it("parses a correctly signed call-ended webhook into the normalised event", () => {
      const harness = makeHarness();
      const event = sampleCallEndedEvent();
      const { rawBody, headers } = harness.signedWebhook(event);
      expect(harness.provider.verifyAndParseWebhook(rawBody, headers)).toEqual(event);
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

    it("deletes call data without error, even when asked twice", async () => {
      const { provider } = makeHarness();
      await provider.deleteCallData("call_contract_delete");
      await expect(provider.deleteCallData("call_contract_delete")).resolves.toBeUndefined();
    });
  });
}
