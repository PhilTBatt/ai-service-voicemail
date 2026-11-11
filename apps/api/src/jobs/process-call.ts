// The process-call job (BUILD_PLAN Step 5): turn a stored transcript into the fields the
// tradesperson needs. Idempotent: a call that's already been extracted is skipped.
import type pg from "pg";
import { phoneFromInput } from "../core/phone.ts";
import {
  dangerScriptSpoken,
  emergencyScriptSpoken,
  gasScriptSpoken,
  waterScriptSpoken,
} from "../core/spoken-scripts.ts";
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
  now?: () => Date;
  /**
   * How long after the call was stored the job keeps waiting for the LLM before sending the texts
   * and email without a summary. The queue retries with backoff (about 30 s, 1, 2, 4, 8 min);
   * past this, the next failure sends what there is rather than retrying again.
   */
  giveUpAfterMs?: number;
}

/** Past this, a tradesperson is better off with "read the transcript" than with nothing. */
export const EXTRACTION_GIVE_UP_AFTER_MS = 3 * 60_000;

/**
 * An LLM error retrying can't fix: a 4xx other than a timeout or a rate limit (a revoked key,
 * no credit, a retired model, a request it won't take). Network errors and 5xx (529 is
 * Anthropic's "overloaded") are worth another go.
 */
function isPermanentLlmError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return (
    typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429
  );
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
    now = () => new Date(),
    giveUpAfterMs = EXTRACTION_GIVE_UP_AFTER_MS,
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
        created_at: Date;
      }>(
        `SELECT transcript, summary, via_fallback, urgency, caller_number, created_at
         FROM calls WHERE id = $1`,
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

  // A mid-call emergency function already marked the call (db/calls.ts), or the agent spoke an
  // emergency script (a caller told to ring 999 often hangs up before that function fires).
  // Either way the extraction can add to it but never downgrade it: over-trigger on purpose.
  const stickyEmergency =
    loaded.call.urgency === "emergency" || emergencyScriptSpoken(loaded.call.transcript);
  // And when a spoken script makes it one, the emergency texts go now, before the LLM is asked
  // anything: if it's down, they mustn't wait for it. The job carries which script, because
  // the call's stored urgency isn't written until after the LLM (a mid-call alert already
  // queued its own job, with its kind). notify-emergency sends each text once.
  const spokenKind = gasScriptSpoken(loaded.call.transcript)
    ? "gas"
    : dangerScriptSpoken(loaded.call.transcript)
      ? "danger"
      : undefined;
  if (spokenKind && enqueueNotifications) {
    await withTenant(pool, tenantId, (client) =>
      enqueueNotifications(client, {
        tenantId,
        callId,
        urgency: "emergency",
        emergencyOnly: true,
        emergencyKind: spokenKind,
      }),
    );
  }

  const prompt = buildExtractionPrompt(transcript, {
    businessName: loaded.tenant.business_name,
    tradespersonName: loaded.tenant.contact_name ?? "the tradesperson",
    callerNumber: loaded.call.caller_number,
  });

  // Invalid output gets one retry; a refusal doesn't. An API error is thrown so the queue
  // retries the whole job with backoff, until retrying can't help (a permanent error, or the
  // call ended over giveUpAfterMs ago): then the call goes on without a summary, and its texts
  // and email still go, saying so. Before this, an outage of 15 to 30 minutes left those calls
  // with no text at all.
  let extraction: CallExtraction | null = null;
  const usages: LlmUsage[] = [];
  try {
    for (let attempt = 1; attempt <= 2 && extraction === null; attempt++) {
      const result = await llm.extract({ ...prompt, schema: callExtractionSchema });
      usages.push(result.usage);
      if (result.ok) extraction = result.value;
      else if (result.reason === "refused") break;
      else logger.warn("LLM output didn't match the schema", { tenantId, callId, attempt });
    }
  } catch (error) {
    // From when the call was stored, not when it ended: one stored late (by reconciliation,
    // or a webhook retried hours on) still gets its retries before giving up.
    const waited = now().getTime() - loaded.call.created_at.getTime();
    if (!isPermanentLlmError(error) && waited < giveUpAfterMs) throw error;
    logger.warn("LLM unavailable: sending the call's messages without a summary", {
      tenantId,
      callId,
      error,
    });
  }

  // The hallucination judge on a sample of calls (BUILD_PLAN Step 7). A failed verdict flags
  // the call for review and raises an alert; the reason stays in the row, never in the logs.
  // A check that can't run is skipped: it must never hold up the texts.
  let judgeVerdict: JudgeVerdict | null = null;
  if (extraction && judgeSampleRate > 0 && random() < judgeSampleRate) {
    try {
      const { usage, ...verdict } = await judgeSummary(llm, null, transcript, extraction);
      usages.push(usage);
      judgeVerdict = verdict;
    } catch (error) {
      logger.warn("Summary check couldn't run: skipped", { tenantId, callId, error });
    }
  }
  const judgeFlags = judgeVerdict && !judgeVerdict.pass ? [JUDGE_FAILED_FLAG] : [];

  // The water script tells the caller "I'm marking this as urgent": at least urgent, then.
  const waterSpoken = waterScriptSpoken(loaded.call.transcript);
  const extracted = extraction?.urgency ?? null;
  const finalUrgency: CallExtraction["urgency"] | null = stickyEmergency
    ? "emergency"
    : waterSpoken && extracted !== "emergency"
      ? "urgent"
      : extracted;

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
            // As E.164, or null when it isn't a number: every text, email and page then falls
            // back to the caller ID rather than printing "0 7700 900123" or a broken tel: link.
            callbackNumber: phoneFromInput(callbackNumber),
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
