// The admin's review queue (BUILD_PLAN Step 10): calls a person should check. Only the
// pipeline's own flags put a call there. The extraction's notes for the tradesperson ("mentioned
// gas smell", "caller abusive") are on nearly every call, and used to put nearly every call in
// the queue with them.
import type { GuardrailHit } from "./guardrails.ts";

/** The agent may have broken a rule: a price, a time, or safety advice (core/guardrails.ts). */
export const guardrailFlag = (rule: GuardrailHit["rule"]) => `guardrail:${rule}` as const;
/** The hallucination judge found the summary unsupported (JUDGE_SAMPLE_RATE). */
export const JUDGE_FAILED_FLAG = "judge:failed";
/** No summary: the tradesperson was told to read the transcript. */
export const EXTRACTION_FAILED_FLAG = "extraction_failed";

const RULES: Record<GuardrailHit["rule"], true> = { price: true, commitment: true, safety: true };

export const REVIEW_FLAGS: readonly string[] = [
  ...(Object.keys(RULES) as GuardrailHit["rule"][]).map(guardrailFlag),
  JUDGE_FAILED_FLAG,
  EXTRACTION_FAILED_FLAG,
];
