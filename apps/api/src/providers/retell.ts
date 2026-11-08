// The Retell AI adapter (decision 007). Maps an AgentDefinition onto Retell's conversation
// flow the way the Step 2 spike proved: a static opening, a prompt node that takes the
// message, uninterruptible global nodes for the fixed scripts, and a static end node.
// Nothing outside this file knows Retell's shapes.
import { createHmac, timingSafeEqual } from "node:crypto";
import { redactText } from "../redact.ts";
import { z } from "zod";
import type { AgentDefinition, FixedScript } from "../core/agent.ts";
import {
  WebhookVerificationError,
  type CallEndedEvent,
  type FunctionCallEvent,
  type InboundCallRegistration,
  type ParsedWebhook,
  type UpsertAgentInput,
  type VoiceProvider,
  type WebhookHeaders,
} from "./voice.ts";
import type { RecordingAudio } from "./recording.ts";

export interface RetellOptions {
  apiKey: string;
  /**
   * Retell signs webhooks and function calls with one specific API key: the one marked with
   * a "webhook" badge in its dashboard. When that isn't the key used for REST calls, it goes
   * here (docs.retellai.com/features/secure-webhook, read 2026-11-07).
   */
  webhookKey?: string;
  /** Where Retell sends call events. Omit until there's a public URL (Step 4). */
  webhookUrl?: string;
  /** Where the flow's emergency functions POST mid-call (Step 6). Omit to build flows without them. */
  functionUrl?: string;
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
    // The provider's own words can quote the address or number it refused. Errors are logged,
    // and stored with failed jobs in the queue's tables, so the detail is redacted here, once.
    super(`Retell ${redactText(path)} failed: HTTP ${status} ${redactText(detail)}`);
    this.status = status;
    this.path = path;
  }
}

/** Retell's answer for something it doesn't have: 404, or the documented 422 "Cannot find requested asset". */
const isGone = (error: unknown) =>
  error instanceof RetellApiError && (error.status === 404 || error.status === 422);

export class RetellVoiceProvider implements VoiceProvider {
  private readonly options: RetellOptions;

  constructor(options: RetellOptions) {
    this.options = options;
  }

  async upsertAgent({ definition, existingProviderAgentId }: UpsertAgentInput) {
    const flow = buildConversationFlow(definition, this.options.functionUrl);
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

  /**
   * Dial to SIP (decision 009): tells Retell which agent takes the call and what the per-call
   * variables are, and gets back the call ID to dial. Retell drops the registration if the
   * dial doesn't arrive within 5 minutes.
   */
  async registerInboundCall({ providerAgentId, from, to, variables }: InboundCallRegistration) {
    const registered = await this.request<{ call_id: string }>("POST", "/v2/register-phone-call", {
      agent_id: providerAgentId,
      direction: "inbound",
      ...(from !== null && { from_number: from }),
      to_number: to,
      retell_llm_dynamic_variables: variables,
    });
    return { sipUri: `sip:${registered.call_id}@sip.retellai.com` };
  }

  verifyAndParseWebhook(rawBody: Buffer, headers: WebhookHeaders): ParsedWebhook {
    this.verifySignature(rawBody, headers["x-retell-signature"]);
    const parsed = webhookSchema.safeParse(parseJson(rawBody, "Webhook"));
    if (!parsed.success) throw new WebhookVerificationError("Malformed Retell webhook body");
    const { event, call } = parsed.data;
    if (event !== "call_ended") return { type: "ignored", reason: `event ${event}` };
    if (!call.to_number) return { type: "ignored", reason: "no dialled number (not a phone call)" };
    return toCallEndedEvent(call, call.to_number);
  }

  verifyAndParseFunctionCall(rawBody: Buffer, headers: WebhookHeaders): FunctionCallEvent {
    // Custom function requests carry the same X-Retell-Signature as webhooks.
    this.verifySignature(rawBody, headers["x-retell-signature"]);
    const parsed = functionCallSchema.safeParse(parseJson(rawBody, "Function call"));
    if (!parsed.success) throw new WebhookVerificationError("Malformed Retell function call body");
    const { name, call } = parsed.data;
    return {
      type: "function_call",
      name,
      providerCallId: call.call_id,
      providerAgentId: call.agent_id,
      dialledNumber: call.to_number ?? null,
      callerNumber: call.from_number ?? null,
    };
  }

  /**
   * Retell's list endpoint (POST /v3/list-calls, read 2026-11-07) leaves transcripts out, so
   * each listed call is fetched in full and mapped exactly as a webhook would be. Web calls
   * and calls still in progress are filtered out server-side.
   */
  async listEndedCalls({ since }: { since: Date }): Promise<CallEndedEvent[]> {
    const events: CallEndedEvent[] = [];
    let paginationKey: string | undefined;
    do {
      const page = await this.request<{
        items: { call_id: string }[];
        has_more: boolean;
        pagination_key?: string;
      }>("POST", "/v3/list-calls", {
        filter_criteria: {
          call_type: { type: "enum", op: "in", value: ["phone_call"] },
          call_status: { type: "enum", op: "in", value: ["ended"] },
          start_timestamp: { type: "range", op: "bt", value: [since.getTime(), Date.now()] },
        },
        sort_order: "descending",
        limit: 1000,
        ...(paginationKey !== undefined && { pagination_key: paginationKey }),
      });
      for (const item of page.items) {
        const call = callSchema.safeParse(
          await this.request("GET", `/v2/get-call/${encodeURIComponent(item.call_id)}`),
        );
        if (call.success && call.data.to_number) {
          events.push(toCallEndedEvent(call.data, call.data.to_number));
        }
      }
      paginationKey = page.has_more ? page.pagination_key : undefined;
    } while (paginationKey);
    return events;
  }

  /**
   * Recording URLs are signed and expire after 24 hours (buildAgent opts the agent in), so
   * the one stored at call end is useless later. Ask Retell for the call again and follow
   * the fresh URL, which needs no further credentials. Null when Retell has no recording
   * (deleted by retention, or the call was never recorded).
   */
  async fetchRecording(providerCallId: string): Promise<RecordingAudio | null> {
    let call: { recording_url?: string };
    try {
      call = await this.request<{ recording_url?: string }>(
        "GET",
        `/v2/get-call/${encodeURIComponent(providerCallId)}`,
      );
    } catch (error) {
      if (error instanceof RetellApiError && error.status === 404) return null;
      throw error;
    }
    if (!call.recording_url) return null;
    const response = await (this.options.fetch ?? fetch)(call.recording_url);
    if (response.status === 404 || response.status === 403) return null;
    if (!response.ok || !response.body) {
      throw new RetellApiError(response.status, "recording", (await response.text()).slice(0, 300));
    }
    return {
      contentType: response.headers.get("content-type") ?? "audio/wav",
      body: response.body,
    };
  }

  async deleteCallData(providerCallId: string) {
    try {
      await this.request("DELETE", `/v2/delete-call/${encodeURIComponent(providerCallId)}`);
    } catch (error) {
      // Already deleted (or expired at Retell): the outcome we wanted.
      if (!(error instanceof RetellApiError && error.status === 404)) throw error;
    }
  }

  // Retell's docs (read 2026-11-07): DELETE /delete-conversation-flow/{id} deletes the flow and
  // all its versions (204; 404 when it's missing), and with force_delete=true it does so even
  // while an agent still uses the flow. DELETE /delete-agent/{id} deletes every version of the
  // agent (204). A missing agent isn't documented as a 404; the documented 422 is "Cannot find
  // requested asset", so both mean gone. The flow goes first: if a run stops between the two, a
  // retry still finds the flow through the agent. The other way round, the flow, with the
  // business's prompt in it, would be stranded.
  async deleteAgent(providerAgentId: string) {
    let flowId: string | null;
    try {
      const agent = await this.request<{ response_engine?: { conversation_flow_id?: string } }>(
        "GET",
        `/get-agent/${encodeURIComponent(providerAgentId)}`,
      );
      flowId = agent.response_engine?.conversation_flow_id ?? null;
    } catch (error) {
      if (isGone(error)) return; // the agent goes last, so its flow went before it
      throw error;
    }
    if (flowId) {
      try {
        await this.request(
          "DELETE",
          `/delete-conversation-flow/${encodeURIComponent(flowId)}?force_delete=true`,
        );
      } catch (error) {
        if (!(error instanceof RetellApiError && error.status === 404)) throw error;
      }
    }
    try {
      await this.request("DELETE", `/delete-agent/${encodeURIComponent(providerAgentId)}`);
    } catch (error) {
      if (!isGone(error)) throw error;
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

    const expected = createHmac("sha256", this.options.webhookKey ?? this.options.apiKey)
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
      // Well inside Twilio's 15-second webhook limit for the register-call path, and far
      // below the sync job's expiry for the agent and flow calls.
      signal: AbortSignal.timeout(10_000),
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

/**
 * The scripts that are emergencies, and the custom function each one calls mid-call so the
 * caller gets the gas number by text and the tradesperson is alerted while the call is still
 * going (BUILD_PLAN Step 6). Names must match db/calls.ts EMERGENCY_FUNCTION_KINDS.
 */
export const EMERGENCY_FUNCTIONS: Partial<
  Record<FixedScript["id"], { name: string; description: string }>
> = {
  gas_emergency: {
    name: "gas_emergency_alert",
    description:
      "Tells the server that the caller reported a gas smell or carbon monoxide, so it can text them the gas emergency number and alert the tradesperson. Call it right after the gas safety message.",
  },
  danger: {
    name: "danger_alert",
    description:
      "Tells the server that the caller reported danger, fire or smoke, so it can alert the tradesperson immediately. Call it right after the danger safety message.",
  },
};

/**
 * Retell's cool_down: "The same global node won't be triggered again within the next N node
 * transitions" (API reference, read 2026-11-08). Our reading, unverified until the live batch
 * run: with 1, the caller's reply straight after a message moves the flow on rather than
 * playing it again, so a dismissal there gets the agent's acknowledgement, and the message can
 * play again (once, by its trigger) on the caller's words after that. A number no call reaches
 * means once a call.
 */
const COOL_DOWN_REPEATABLE = 1;
export const COOL_DOWN_ONCE_PER_CALL = 1000;

function scriptNode(script: FixedScript, functionUrl: string | undefined) {
  // An emergency script hands on to its alert function node; the rest go straight back to
  // taking the message.
  const next =
    functionUrl && EMERGENCY_FUNCTIONS[script.id] ? `${script.id}_alert` : "take_message";
  return {
    id: script.id,
    type: "conversation",
    instruction: staticText(script.text),
    // The caller can't talk over a safety message, and it's repeated (re-fired) rather
    // than paraphrased if dismissed. Afterwards the call carries on; never "go back".
    interruption_sensitivity: 0,
    global_node_setting: {
      condition: script.trigger,
      cool_down: script.oncePerCall ? COOL_DOWN_ONCE_PER_CALL : COOL_DOWN_REPEATABLE,
    },
    edges: [promptEdge(`${script.id}_continue`, "The caller has responded", next)],
  };
}

/**
 * The flow's custom tools and the function nodes that call them. The node fires the request
 * without waiting for a result or saying anything, then carries on to take the message.
 * UNVERIFIED against Retell until the live contract test runs: the edge shape on a
 * function node is taken from the API reference, not from a working flow.
 */
function emergencyTooling(definition: AgentDefinition, functionUrl: string) {
  const scripts = definition.scripts.filter((script) => EMERGENCY_FUNCTIONS[script.id]);
  return {
    tools: scripts.map((script) => {
      const fn = EMERGENCY_FUNCTIONS[script.id]!;
      return {
        tool_id: fn.name,
        type: "custom",
        name: fn.name,
        description: fn.description,
        url: functionUrl,
        method: "POST",
        parameters: { type: "object", properties: {} },
        speak_during_execution: false,
        speak_after_execution: false,
        timeout_ms: 5000,
        max_retry: 1, // our endpoint is idempotent (one row, one job per call)
      };
    }),
    nodes: scripts.map((script) => ({
      id: `${script.id}_alert`,
      type: "function",
      tool_id: EMERGENCY_FUNCTIONS[script.id]!.name,
      tool_type: "local",
      wait_for_result: false,
      speak_during_execution: false,
      edges: [promptEdge(`${script.id}_alert_continue`, "The alert has been sent", "take_message")],
      else_edge: {
        id: `${script.id}_alert_else`,
        transition_condition: { type: "prompt", prompt: "Else" },
        destination_node_id: "take_message",
      },
    })),
  };
}

export function buildConversationFlow(definition: AgentDefinition, functionUrl?: string) {
  const emergency = functionUrl
    ? emergencyTooling(definition, functionUrl)
    : { tools: [], nodes: [] };
  return {
    start_speaker: "agent",
    start_node_id: "opening",
    global_prompt: definition.instructions,
    model_config: MODEL_CONFIG,
    ...(emergency.tools.length > 0 && { tools: emergency.tools }),
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
        // The same wording the eval simulation decides "done" by (evals/simulate.ts).
        edges: [promptEdge("message_to_close", definition.closeWhen, "close")],
      },
      ...definition.scripts.map((script) => scriptNode(script, functionUrl)),
      ...emergency.nodes,
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
    // Recording and log URLs carry a signature and expire after 24 hours, instead of being
    // open to anyone with the link. The API fetches a fresh one when it streams a recording.
    opt_in_signed_url: true,
    // Retell deletes its copy after 30 days too (BUILD_PLAN Step 5: recordings 30 days at
    // the provider and ours); our retention job normally gets there first.
    data_storage_retention_days: 30,
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

// A custom function request: { name, call, args }. The call is Retell's full call object;
// only the identifying fields are read.
const functionCallSchema = z.object({
  name: z.string().min(1),
  call: z.object({
    call_id: z.string(),
    agent_id: z.string(),
    from_number: z.string().optional(),
    to_number: z.string().optional(),
  }),
  args: z.unknown().optional(),
});

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
    // Floor, not round: a 4,900 ms call is 4 seconds and must not be billed as 5.
    durationSeconds: Math.floor(durationMs / 1000),
    endReason: call.disconnection_reason ?? "unknown",
    transcript,
    recordingRef: call.recording_url ?? null,
    costs,
  };
}

/** A verified body that still isn't JSON is treated like a bad signature, not a crash. */
function parseJson(rawBody: Buffer, what: string): unknown {
  try {
    return JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new WebhookVerificationError(`${what} body is not JSON`);
  }
}

/** Signs a body the way Retell does. Exported for tests and fixtures only. */
export function signRetellWebhook(rawBody: Buffer, apiKey: string, timestampMs: number): string {
  const digest = createHmac("sha256", apiKey)
    .update(Buffer.concat([rawBody, Buffer.from(String(timestampMs))]))
    .digest("hex");
  return `v=${timestampMs},d=${digest}`;
}
