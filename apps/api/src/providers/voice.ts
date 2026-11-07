// The seam between CallMate and the managed voice platform. Every platform-specific detail
// lives in an adapter behind this interface; core and the rest of the API only see these
// types. Swapping platforms later is a new adapter, not a rewrite.
import type { AgentDefinition } from "../core/agent.ts";
import type { RecordingAudio } from "./recording.ts";

export interface UpsertAgentInput {
  definition: AgentDefinition;
  /** The platform's ID from the last sync, so the same agent is updated rather than duplicated. */
  existingProviderAgentId: string | null;
}

/** A call our telephony is about to hand to the platform (Dial to SIP, decision 009). */
export interface InboundCallRegistration {
  providerAgentId: string;
  /** E.164, or null when the caller withheld their number. */
  from: string | null;
  /** E.164: the tenant's number. */
  to: string;
  /** The values the agent's instructions refer to as {{name}}. */
  variables: Record<string, string>;
}

export interface TranscriptTurn {
  role: "agent" | "caller";
  text: string;
}

/** One cost component of a call, in the platform's own units. Prices are applied later. */
export interface CostComponent {
  component: string;
  units: number;
  unitType: string;
}

/** A finished call, normalised. The webhook route stores this and enqueues processing. */
export interface CallEndedEvent {
  type: "call_ended";
  providerCallId: string;
  providerAgentId: string;
  /** E.164. The tenant is identified only by the number dialled. */
  dialledNumber: string;
  /** E.164, or null when the caller withheld their number. */
  callerNumber: string | null;
  startedAt: Date;
  endedAt: Date;
  durationSeconds: number;
  /** The platform's own reason, kept as-is for debugging (for example "agent_hangup"). */
  endReason: string;
  transcript: TranscriptTurn[];
  /** Where the platform holds the recording. Never exposed to users; the API streams it. */
  recordingRef: string | null;
  costs: CostComponent[];
}

/**
 * The platform calling our API from inside a call: a custom function in the flow fired
 * (BUILD_PLAN Step 6, the mid-call emergency path). Verified like a webhook.
 */
export interface FunctionCallEvent {
  type: "function_call";
  /** The function's name as the flow defines it, for example "gas_emergency_alert". */
  name: string;
  providerCallId: string;
  providerAgentId: string;
  /** E.164, or null for a web call. */
  dialledNumber: string | null;
  callerNumber: string | null;
}

/** A genuine webhook that needs no action, such as "call started". */
export interface IgnoredWebhook {
  type: "ignored";
  reason: string;
}

export type ParsedWebhook = CallEndedEvent | IgnoredWebhook;

export type WebhookHeaders = Record<string, string | string[] | undefined>;

/** The request didn't come from the platform, or was tampered with. The route answers 401. */
export class WebhookVerificationError extends Error {
  override readonly name = "WebhookVerificationError";
}

export interface VoiceProvider {
  /** Creates or updates the platform agent for a definition. Must be safe to repeat. */
  upsertAgent(input: UpsertAgentInput): Promise<{ providerAgentId: string }>;
  /**
   * Registers a call that's about to be dialled to the platform and returns the SIP URI to
   * dial. The dial must follow within minutes.
   */
  registerInboundCall(registration: InboundCallRegistration): Promise<{ sipUri: string }>;
  /**
   * Verifies a webhook against the raw bytes (signatures are computed over the raw body,
   * so a re-serialised object fails) and returns a normalised event.
   */
  verifyAndParseWebhook(rawBody: Buffer, headers: WebhookHeaders): ParsedWebhook;
  /** Verifies a mid-call function request the same way and returns who is calling about which call. */
  verifyAndParseFunctionCall(rawBody: Buffer, headers: WebhookHeaders): FunctionCallEvent;
  /** Deletes the recording, transcript and logs at the platform. Must be safe to repeat. */
  deleteCallData(providerCallId: string): Promise<void>;
  /**
   * Deletes an agent, with everything it holds about the business (its prompt and flow), at the
   * platform. Must be safe to repeat. For deleting a business's data (BUILD_PLAN Step 13).
   */
  deleteAgent(providerAgentId: string): Promise<void>;
  /** The call's recording, fetched fresh from the platform, or null if it has none (or no longer). */
  fetchRecording(providerCallId: string): Promise<RecordingAudio | null>;
  /**
   * Phone calls that ended since a point in time, as the webhook would have reported them.
   * For finding calls whose webhook never arrived.
   */
  listEndedCalls(window: { since: Date }): Promise<CallEndedEvent[]>;
}
