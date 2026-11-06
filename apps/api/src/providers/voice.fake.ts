import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { AgentDefinition } from "../core/agent.ts";
import {
  WebhookVerificationError,
  type CallEndedEvent,
  type ParsedWebhook,
  type UpsertAgentInput,
  type VoiceProvider,
  type WebhookHeaders,
} from "./voice.ts";

const SIGNATURE_HEADER = "x-fake-signature";

const webhookSchema = z.object({
  event: z.string(),
  call: z
    .object({
      providerCallId: z.string(),
      providerAgentId: z.string(),
      dialledNumber: z.string(),
      callerNumber: z.string().nullable(),
      startedAt: z.iso.datetime(),
      endedAt: z.iso.datetime(),
      durationSeconds: z.number(),
      endReason: z.string(),
      transcript: z.array(z.object({ role: z.enum(["agent", "caller"]), text: z.string() })),
      recordingRef: z.string().nullable(),
      costs: z.array(z.object({ component: z.string(), units: z.number(), unitType: z.string() })),
    })
    .optional(),
});

/**
 * An in-memory VoiceProvider for tests. It records everything it's asked to do, and signs
 * its webhooks like a real platform (an HMAC over the raw body), so route tests cover
 * verification end to end.
 */
export class FakeVoiceProvider implements VoiceProvider {
  private readonly signingKey = "not-a-real-key";
  readonly agents = new Map<string, AgentDefinition>();
  /** E.164 number → provider agent ID. */
  readonly numbers = new Map<string, string>();
  readonly deleteCalls: string[] = [];
  private nextId = 1;

  upsertAgent({ definition, existingProviderAgentId }: UpsertAgentInput) {
    const providerAgentId =
      existingProviderAgentId !== null && this.agents.has(existingProviderAgentId)
        ? existingProviderAgentId
        : `fake_agent_${this.nextId++}`;
    this.agents.set(providerAgentId, definition);
    return Promise.resolve({ providerAgentId });
  }

  attachNumber(providerAgentId: string, number: string) {
    if (!this.agents.has(providerAgentId)) {
      return Promise.reject(new Error(`Unknown agent ${providerAgentId}`));
    }
    this.numbers.set(number, providerAgentId);
    return Promise.resolve();
  }

  private sign(rawBody: Buffer): string {
    return createHmac("sha256", this.signingKey).update(rawBody).digest("hex");
  }

  verifyAndParseWebhook(rawBody: Buffer, headers: WebhookHeaders): ParsedWebhook {
    const given = headers[SIGNATURE_HEADER];
    const expected = this.sign(rawBody);
    if (
      typeof given !== "string" ||
      given.length !== expected.length ||
      !timingSafeEqual(Buffer.from(given), Buffer.from(expected))
    ) {
      throw new WebhookVerificationError("Invalid fake signature");
    }
    const parsed = webhookSchema.safeParse(JSON.parse(rawBody.toString("utf8")));
    if (!parsed.success) throw new WebhookVerificationError("Malformed fake webhook body");
    const { event, call } = parsed.data;
    if (event !== "call_ended" || !call) return { type: "ignored", reason: `event ${event}` };
    return {
      type: "call_ended",
      ...call,
      startedAt: new Date(call.startedAt),
      endedAt: new Date(call.endedAt),
    };
  }

  deleteCallData(providerCallId: string) {
    this.deleteCalls.push(providerCallId);
    return Promise.resolve();
  }

  /** Builds a signed webhook request for an event, as the platform would send it. */
  webhookFor(event: CallEndedEvent | { event: string }): {
    rawBody: Buffer;
    headers: WebhookHeaders;
  } {
    const body = "event" in event ? event : { event: "call_ended", call: event };
    return this.signedRequest(Buffer.from(JSON.stringify(body)));
  }

  /** Signs any raw body, so tests can send correctly signed but malformed requests. */
  signedRequest(rawBody: Buffer): { rawBody: Buffer; headers: WebhookHeaders } {
    return {
      rawBody,
      headers: { "content-type": "application/json", [SIGNATURE_HEADER]: this.sign(rawBody) },
    };
  }
}
