// The Retell AI adapter (decision 007). Maps an AgentDefinition onto Retell's conversation
// flow the way the Step 2 spike proved: a static opening, a prompt node that takes the
// message, uninterruptible global nodes for the fixed scripts, and a static end node.
// Nothing outside this file knows Retell's shapes.
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { AgentDefinition, FixedScript } from "../core/agent.ts";
import {
  WebhookVerificationError,
  type CallEndedEvent,
  type ParsedWebhook,
  type UpsertAgentInput,
  type VoiceProvider,
  type WebhookHeaders,
} from "./voice.ts";

export interface RetellOptions {
  apiKey: string;
  /** Where Retell sends call events. Omit until there's a public URL (Step 4). */
  webhookUrl?: string;
  /** Injected by tests. */
  fetch?: typeof fetch;
  now?: () => Date;
}

const BASE_URL = "https://api.retellai.com";
/** Retell's documented replay window for webhook signatures. */
const SIGNATURE_MAX_AGE_MS = 5 * 60_000;

/** Retell's recommended model at the standard tier; faster tiers cost more (decision 007). */
const MODEL_CONFIG = {
  type: "cascading",
  primary: { model: "gpt-5.6-terra", tier: "standard" },
  temperature: 0,
};

// Only Willa and Maren are British *platform* voices (automatic voice fallback). There's no
// British male platform voice, so that option names its own fallbacks.
const VOICES = {
  female: { voice_id: "retell-Willa" },
  male: { voice_id: "11labs-Anthony", fallback_voice_ids: ["cartesia-Anthony", "openai-Anthony"] },
};

export class RetellApiError extends Error {
  override readonly name = "RetellApiError";
  readonly status: number;
  readonly path: string;

  constructor(status: number, path: string, detail: string) {
    super(`Retell ${path} failed: HTTP ${status} ${detail}`);
    this.status = status;
    this.path = path;
  }
}

export class RetellVoiceProvider implements VoiceProvider {
  private readonly options: RetellOptions;

  constructor(options: RetellOptions) {
    this.options = options;
  }

  async upsertAgent({ definition, existingProviderAgentId }: UpsertAgentInput) {
    const flow = buildConversationFlow(definition);
    const agent = buildAgent(definition, this.options.webhookUrl);

    if (existingProviderAgentId !== null) {
      const existing = await this.findAgent(existingProviderAgentId);
      if (existing) {
        await this.request("PATCH", `/update-conversation-flow/${existing.flowId}`, flow);
        await this.request("PATCH", `/update-agent/${existingProviderAgentId}`, agent);
        return { providerAgentId: existingProviderAgentId };
      }
      // The agent we knew about is gone at Retell (deleted by hand?): create a fresh one.
    }

    const created = await this.request<{ conversation_flow_id: string }>(
      "POST",
      "/create-conversation-flow",
      flow,
    );
    const createdAgent = await this.request<{ agent_id: string }>("POST", "/create-agent", {
      ...agent,
      response_engine: {
        type: "conversation-flow",
        conversation_flow_id: created.conversation_flow_id,
      },
    });
    return { providerAgentId: createdAgent.agent_id };
  }

  /** Points an imported number's inbound calls at an agent. The number must already exist at Retell. */
  async attachNumber(providerAgentId: string, number: string) {
    await this.request("PATCH", `/update-phone-number/${encodeURIComponent(number)}`, {
      inbound_agents: [{ agent_id: providerAgentId, weight: 1 }],
    });
  }

  verifyAndParseWebhook(rawBody: Buffer, headers: WebhookHeaders): ParsedWebhook {
    this.verifySignature(rawBody, headers["x-retell-signature"]);

    const parsed = webhookSchema.safeParse(JSON.parse(rawBody.toString("utf8")));
    if (!parsed.success) throw new WebhookVerificationError("Malformed Retell webhook body");
    const { event, call } = parsed.data;
    if (event !== "call_ended") return { type: "ignored", reason: `event ${event}` };
    if (!call.to_number) return { type: "ignored", reason: "no dialled number (not a phone call)" };
    return toCallEndedEvent(call, call.to_number);
  }

  async deleteCallData(providerCallId: string) {
    try {
      await this.request("DELETE", `/v2/delete-call/${encodeURIComponent(providerCallId)}`);
    } catch (error) {
      // Already deleted (or expired at Retell): the outcome we wanted.
      if (!(error instanceof RetellApiError && error.status === 404)) throw error;
    }
  }

  private verifySignature(rawBody: Buffer, header: string | string[] | undefined): void {
    // Retell: X-Retell-Signature is "v={unix ms},d={hex}", where d is
    // HMAC-SHA256(rawBody + timestamp, apiKey). Timestamps older than 5 minutes are replays.
    const match = typeof header === "string" ? /^v=(\d+),d=([0-9a-f]+)$/.exec(header) : null;
    if (!match) throw new WebhookVerificationError("Missing or malformed X-Retell-Signature");
    const [, timestamp, digest] = match as unknown as [string, string, string];

    const age = Math.abs((this.options.now ?? (() => new Date()))().getTime() - Number(timestamp));
    if (age > SIGNATURE_MAX_AGE_MS) throw new WebhookVerificationError("Stale webhook signature");

    const expected = createHmac("sha256", this.options.apiKey)
      .update(Buffer.concat([rawBody, Buffer.from(timestamp)]))
      .digest("hex");
    if (
      digest.length !== expected.length ||
      !timingSafeEqual(Buffer.from(digest), Buffer.from(expected))
    ) {
      throw new WebhookVerificationError("Invalid webhook signature");
    }
  }

  private async findAgent(agentId: string): Promise<{ flowId: string } | null> {
    try {
      const agent = await this.request<{ response_engine?: { conversation_flow_id?: string } }>(
        "GET",
        `/get-agent/${encodeURIComponent(agentId)}`,
      );
      const flowId = agent.response_engine?.conversation_flow_id;
      if (!flowId) throw new Error(`Retell agent ${agentId} has no conversation flow`);
      return { flowId };
    } catch (error) {
      if (error instanceof RetellApiError && error.status === 404) return null;
      throw error;
    }
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await (this.options.fetch ?? fetch)(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw new RetellApiError(response.status, path, (await response.text()).slice(0, 300));
    }
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  }
}

// ─── AgentDefinition → Retell ──────────────────────────────────────────────────────────

const staticText = (text: string) => ({ type: "static_text", text });
const promptEdge = (id: string, prompt: string, destination: string) => ({
  id,
  transition_condition: { type: "prompt", prompt },
  destination_node_id: destination,
});

function scriptNode(script: FixedScript) {
  return {
    id: script.id,
    type: "conversation",
    instruction: staticText(script.text),
    // The caller can't talk over a safety message, and it's repeated (re-fired) rather
    // than paraphrased if dismissed. Afterwards the call carries on; never "go back".
    interruption_sensitivity: 0,
    global_node_setting: { condition: script.trigger, cool_down: 1 },
    edges: [promptEdge(`${script.id}_continue`, "The caller has responded", "take_message")],
  };
}

export function buildConversationFlow(definition: AgentDefinition) {
  return {
    start_speaker: "agent",
    start_node_id: "opening",
    global_prompt: definition.instructions,
    model_config: MODEL_CONFIG,
    nodes: [
      {
        id: "opening",
        type: "conversation",
        instruction: staticText(definition.opening),
        interruption_sensitivity: 0, // the recording disclosure must be heard in full
        edges: [promptEdge("opening_to_message", "The caller has said anything", "take_message")],
      },
      {
        id: "take_message",
        type: "conversation",
        instruction: {
          type: "prompt",
          text: "Take the caller's message as your instructions describe, one question at a time.",
        },
        edges: [
          promptEdge(
            "message_to_close",
            "You have the caller's name, a confirmed call-back number, their postcode, the job and its urgency, or the caller wants to end the call",
            "close",
          ),
        ],
      },
      ...definition.scripts.map(scriptNode),
      {
        id: "close",
        type: "end",
        speak_during_execution: true,
        instruction: staticText(definition.close),
      },
    ],
  };
}

export function buildAgent(definition: AgentDefinition, webhookUrl?: string) {
  const { limits } = definition;
  return {
    agent_name: `CallMate ${definition.tenantId} v${definition.profileVersion}`,
    ...VOICES[definition.voice.gender],
    language: definition.language,
    begin_message_delay_ms: limits.beginMessageDelayMs,
    max_call_duration_ms: limits.maxCallSeconds * 1000,
    // After silence: one reminder, then end the call. (Retell has no wrap-up timer, so
    // wrapUpAfterSeconds isn't mapped yet; Step 7 revisits the agent limits.)
    reminder_trigger_ms: limits.silenceReminderSeconds * 1000,
    reminder_max_count: 1,
    end_call_after_silence_ms: limits.endAfterSilenceSeconds * 1000,
    ...(webhookUrl !== undefined && { webhook_url: webhookUrl }),
  };
}

// ─── Retell webhook → CallEndedEvent ───────────────────────────────────────────────────

const callSchema = z.object({
  call_id: z.string(),
  agent_id: z.string(),
  from_number: z.string().optional(),
  to_number: z.string().optional(),
  start_timestamp: z.number(),
  end_timestamp: z.number().optional(),
  duration_ms: z.number().optional(),
  disconnection_reason: z.string().optional(),
  transcript_object: z
    .array(z.object({ role: z.string(), content: z.string().optional() }))
    .optional(),
  recording_url: z.string().optional(),
  call_cost: z
    .object({
      product_costs: z.array(z.object({ product: z.string(), cost: z.number() })).optional(),
      total_duration_seconds: z.number().optional(),
    })
    .optional(),
});

const webhookSchema = z.object({ event: z.string(), call: callSchema });

type RetellCall = z.infer<typeof callSchema>;

function toCallEndedEvent(call: RetellCall, dialledNumber: string): CallEndedEvent {
  const startedAt = new Date(call.start_timestamp);
  const endedAt = new Date(call.end_timestamp ?? call.start_timestamp);
  const durationMs = call.duration_ms ?? endedAt.getTime() - startedAt.getTime();
  const transcript: CallEndedEvent["transcript"] = [];
  for (const turn of call.transcript_object ?? []) {
    // Tool calls and node transitions also appear here; only speech is kept.
    if (turn.role === "agent") transcript.push({ role: "agent", text: turn.content ?? "" });
    else if (turn.role === "user") transcript.push({ role: "caller", text: turn.content ?? "" });
  }
  const costs: CallEndedEvent["costs"] = (call.call_cost?.product_costs ?? []).map((item) => ({
    component: `retell:${item.product}`,
    units: item.cost,
    unitType: "usd_cents", // Retell reports actual cost per product, in US cents
  }));
  if (call.call_cost?.total_duration_seconds !== undefined) {
    costs.push({
      component: "retell:duration",
      units: call.call_cost.total_duration_seconds,
      unitType: "seconds",
    });
  }
  return {
    type: "call_ended",
    providerCallId: call.call_id,
    providerAgentId: call.agent_id,
    dialledNumber,
    callerNumber: call.from_number ?? null,
    startedAt,
    endedAt,
    durationSeconds: Math.round(durationMs / 1000),
    endReason: call.disconnection_reason ?? "unknown",
    transcript,
    recordingRef: call.recording_url ?? null,
    costs,
  };
}

/** Signs a body the way Retell does. Exported for tests and fixtures only. */
export function signRetellWebhook(rawBody: Buffer, apiKey: string, timestampMs: number): string {
  const digest = createHmac("sha256", apiKey)
    .update(Buffer.concat([rawBody, Buffer.from(String(timestampMs))]))
    .digest("hex");
  return `v=${timestampMs},d=${digest}`;
}
