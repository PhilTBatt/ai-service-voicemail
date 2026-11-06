// The process-call job (BUILD_PLAN Step 5): turn a stored transcript into the fields the
// tradesperson needs. Idempotent: a call that's already been extracted is skipped.
import type pg from "pg";
import { raiseAlert, type AlertFn } from "../alerts.ts";
import {
  EXTRACTION_FAILED_SUMMARY,
  buildExtractionPrompt,
  callExtractionSchema,
  type CallExtraction,
} from "../core/extraction.ts";
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
}

export type ProcessCallOutcome =
  "extracted" | "extraction-failed" | "already-processed" | "no-transcript";

export async function runProcessCall(
  { pool, llm, alert = raiseAlert }: ProcessCallDeps,
  { tenantId, callId }: ProcessCallJobData,
): Promise<ProcessCallOutcome> {
  const loaded = await withTenant(pool, tenantId, async (client) => {
    const call = (
      await client.query<{
        transcript: string | null;
        summary: string | null;
        via_fallback: boolean;
      }>("SELECT transcript, summary, via_fallback FROM calls WHERE id = $1", [callId])
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

  const prompt = buildExtractionPrompt(parseTranscript(loaded.call.transcript), {
    businessName: loaded.tenant.business_name,
    tradespersonName: loaded.tenant.contact_name ?? "the tradesperson",
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

  const inputTokens = usages.reduce((n, u) => n + u.inputTokens, 0);
  const outputTokens = usages.reduce((n, u) => n + u.outputTokens, 0);

  await withTenant(pool, tenantId, async (client) => {
    if (extraction) {
      const { jobSummary, urgency, flags, ...fields } = extraction;
      await client.query(
        `UPDATE calls SET summary = $2, urgency = $3, flags = $4, extracted_fields = $5 WHERE id = $1`,
        [
          callId,
          jobSummary,
          urgency,
          flags,
          JSON.stringify({ ...fields, priceAsked: extraction.priceAsked }),
        ],
      );
    } else {
      await client.query(
        `UPDATE calls SET summary = $2, flags = array_append(flags, 'extraction_failed') WHERE id = $1`,
        [callId, EXTRACTION_FAILED_SUMMARY],
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
  });

  if (!extraction) {
    alert("call-extraction-failed", { tenantId, callId });
    return "extraction-failed";
  }
  logger.info("Call extracted", { tenantId, callId, urgency: extraction.urgency });
  return "extracted";
}

/** The transcript as stored by recordCallEnded: one "role: text" line per turn. */
function parseTranscript(stored: string): TranscriptTurn[] {
  return stored.split("\n").map((line) => {
    const match = /^(agent|caller): (.*)$/.exec(line);
    return match
      ? { role: match[1] as TranscriptTurn["role"], text: match[2] ?? "" }
      : { role: "caller", text: line };
  });
}
