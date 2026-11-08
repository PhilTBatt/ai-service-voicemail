// The process-call job (BUILD_PLAN Step 5): turn a stored transcript into the fields the
// tradesperson needs. Idempotent: a call that's already been extracted is skipped.
import type pg from "pg";
import { emergencyScriptSpoken } from "../core/spoken-scripts.ts";
import { raiseAlert, type AlertFn } from "../alerts.ts";
import {
  EXTRACTION_FAILED_SUMMARY,
  buildExtractionPrompt,
  callExtractionSchema,
  type CallExtraction,
} from "../core/extraction.ts";
import { scanAgentTurns } from "../core/guardrails.ts";
import { EXTRACTION_FAILED_FLAG, JUDGE_FAILED_FLAG, guardrailFlag } from "../core/review.ts";
import { judgeSummary, type JudgeVerdict } from "../evals/judge.ts";
import type { EnqueueNotifications } from "./enqueue-notifications.ts";
import { withTenant } from "../db/tenant.ts";
import { logger } from "../logger.ts";
import type { LlmProvider, LlmUsage } from "../providers/llm.ts";
import type { TranscriptTurn } from "../providers/voice.ts";

export interface ProcessCallJobData {
  tenantId: string;
  callId: string;
  providerCallId: string;
}

export interface ProcessCallDeps {
  pool: pg.Pool;
  llm: LlmProvider;
  alert?: AlertFn;
  enqueueNotifications?: EnqueueNotifications;
  /** Share of calls (0 to 1) whose summary the hallucination judge checks. Off by default. */
  judgeSampleRate?: number;
  /** Injected by tests. */
  random?: () => number;
}

export type ProcessCallOutcome =
  "extracted" | "extraction-failed" | "already-processed" | "no-transcript";

export async function runProcessCall(
  {
    pool,
    llm,
    alert = raiseAlert,
    enqueueNotifications,
    judgeSampleRate = 0,
    random = Math.random,
  }: ProcessCallDeps,
  { tenantId, callId }: ProcessCallJobData,
): Promise<ProcessCallOutcome> {
  const loaded = await withTenant(pool, tenantId, async (client) => {
    const call = (
      await client.query<{
        transcript: string | null;
        summary: string | null;
        via_fallback: boolean;
        urgency: string | null;
        caller_number: string | null;
      }>(
        "SELECT transcript, summary, via_fallback, urgency, caller_number FROM calls WHERE id = $1",
        [callId],
      )
    ).rows[0];
    if (!call) throw new Error(`Call ${callId} not found for tenant ${tenantId}`);
    const tenant = (
      await client.query<{ business_name: string; contact_name: string | null }>(
        "SELECT business_name, contact_name FROM tenants WHERE id = $1",
        [tenantId],
      )
    ).rows[0];
    if (!tenant) throw new Error(`Tenant ${tenantId} not found`);
    return { call, tenant };
  });

  if (loaded.call.summary !== null) {
    logger.info("Call already processed", { tenantId, callId });
    return "already-processed";
  }
  if (!loaded.call.transcript || loaded.call.via_fallback) {
    // Fallback voicemails have a recording, not a transcript (Step 5's retention and Step 6
    // handle them); there's nothing to extract from.
    return "no-transcript";
  }

  const transcript = parseTranscript(loaded.call.transcript);

  // The agent must never quote prices or commit to times. A match flags the call for
  // review; the excerpts stay in the tenant's row, never in the alert.
  const guardrailHits = scanAgentTurns(transcript);
  const guardrailFlags = [...new Set(guardrailHits.map((hit) => guardrailFlag(hit.rule)))];

  const prompt = buildExtractionPrompt(transcript, {
    businessName: loaded.tenant.business_name,
    tradespersonName: loaded.tenant.contact_name ?? "the tradesperson",
    callerNumber: loaded.call.caller_number,
  });

  // Invalid output gets one retry; a refusal doesn't. API errors propagate, so the queue
  // retries the whole job with backoff.
  let extraction: CallExtraction | null = null;
  const usages: LlmUsage[] = [];
  for (let attempt = 1; attempt <= 2 && extraction === null; attempt++) {
    const result = await llm.extract({ ...prompt, schema: callExtractionSchema });
    usages.push(result.usage);
    if (result.ok) extraction = result.value;
    else if (result.reason === "refused") break;
    else logger.warn("LLM output didn't match the schema", { tenantId, callId, attempt });
  }

  // The hallucination judge on a sample of calls (BUILD_PLAN Step 7). A failed verdict flags
  // the call for review and raises an alert; the reason stays in the row, never in the logs.
  let judgeVerdict: JudgeVerdict | null = null;
  if (extraction && judgeSampleRate > 0 && random() < judgeSampleRate) {
    const { usage, ...verdict } = await judgeSummary(llm, null, transcript, extraction);
    usages.push(usage);
    judgeVerdict = verdict;
  }
  const judgeFlags = judgeVerdict && !judgeVerdict.pass ? [JUDGE_FAILED_FLAG] : [];

  // A mid-call emergency function already marked the call (db/calls.ts), or the agent spoke an
  // emergency script (a caller told to ring 999 often hangs up before that function fires).
  // Either way the extraction can add to it but never downgrade it: over-trigger on purpose.
  const stickyEmergency =
    loaded.call.urgency === "emergency" || emergencyScriptSpoken(loaded.call.transcript);
  const finalUrgency: CallExtraction["urgency"] | null = stickyEmergency
    ? "emergency"
    : (extraction?.urgency ?? null);

  const inputTokens = usages.reduce((n, u) => n + u.inputTokens, 0);
  const outputTokens = usages.reduce((n, u) => n + u.outputTokens, 0);

  await withTenant(pool, tenantId, async (client) => {
    if (extraction) {
      const { jobSummary, flags, callerName, callbackNumber, postcode, priceAsked } = extraction;
      await client.query(
        `UPDATE calls SET summary = $2, urgency = $3, flags = flags || $4::text[], extracted_fields = $5
         WHERE id = $1`,
        [
          callId,
          jobSummary,
          finalUrgency,
          [...flags, ...guardrailFlags, ...judgeFlags],
          JSON.stringify({
            callerName,
            callbackNumber,
            postcode,
            priceAsked,
            guardrailHits,
            ...(judgeVerdict && { judge: judgeVerdict }),
          }),
        ],
      );
    } else {
      // No summary, but a known emergency (a spoken script) is still recorded as one.
      await client.query(
        `UPDATE calls SET summary = $2, flags = flags || $3::text[],
                          extracted_fields = extracted_fields || $4::jsonb,
                          urgency = COALESCE($5, urgency)
         WHERE id = $1`,
        [
          callId,
          EXTRACTION_FAILED_SUMMARY,
          [EXTRACTION_FAILED_FLAG, ...guardrailFlags],
          JSON.stringify({ guardrailHits }),
          finalUrgency,
        ],
      );
    }
    for (const [component, units] of [
      [`${llm.model}:input_tokens`, inputTokens],
      [`${llm.model}:output_tokens`, outputTokens],
    ] as const) {
      await client.query(
        `INSERT INTO call_costs (tenant_id, call_id, component, units, unit_type, is_estimated)
         VALUES ($1, $2, $3, $4, 'tokens', false)`,
        [tenantId, callId, component, units],
      );
    }
    // Even a failed extraction gets a text: the summary says to read the transcript.
    await enqueueNotifications?.(client, { tenantId, callId, urgency: finalUrgency });
  });

  if (guardrailHits.length > 0) {
    alert("guardrail-hit", { tenantId, callId, rules: guardrailFlags });
  }
  if (judgeVerdict && !judgeVerdict.pass) alert("summary-judge-failed", { tenantId, callId });
  if (!extraction) {
    alert("call-extraction-failed", { tenantId, callId });
    return "extraction-failed";
  }
  logger.info("Call extracted", { tenantId, callId, urgency: finalUrgency });
  return "extracted";
}

/** The transcript as stored by recordCallEnded: one "role: text" line per turn. */
export function parseTranscript(stored: string): TranscriptTurn[] {
  return stored.split("\n").map((line) => {
    const match = /^(agent|caller): (.*)$/.exec(line);
    return match
      ? { role: match[1] as TranscriptTurn["role"], text: match[2] ?? "" }
      : { role: "caller", text: line };
  });
}
