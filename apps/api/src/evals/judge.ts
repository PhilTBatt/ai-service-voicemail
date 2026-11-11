// The hallucination judge (BUILD_PLAN Step 7): a model reads the transcript and the summary
// the pipeline produced, and says whether the summary is supported by what was actually
// said. Runs on the eval set; sampling production calls is a separate, off-by-default switch
// for later.
import { z } from "zod";
import { URGENCY_RULES, type CallExtraction } from "../core/extraction.ts";
import type { LlmProvider, LlmUsage } from "../providers/llm.ts";
import type { TranscriptTurn } from "../providers/voice.ts";
import type { CostMeter } from "./cost.ts";

export const judgeSchema = z.object({
  /**
   * The judge's checking, written before its verdict. The limit is generous: with the urgency
   * rules to weigh, the judge's reasons outgrew 400 characters and seven verdicts in the
   * 2026-11-08 run were thrown away as invalid.
   *
   * First, not second: the structured output is written in the schema's order, and with `pass`
   * first the judge committed to a verdict before it had checked anything. In the 2026-11-11
   * run, five of its seven failures ended their reasoning "so this should pass": the evals
   * undercounted, and the same judge in process-call flagged good summaries as doubted.
   */
  reason: z.string().min(1).max(1500),
  /** The verdict, which follows from the reasoning above it. */
  pass: z.boolean(),
});
export type JudgeVerdict = z.infer<typeof judgeSchema>;

export function buildJudgePrompt(transcript: TranscriptTurn[], extraction: CallExtraction) {
  const system = `You check summaries of phone calls for hallucination. You are given the transcript of a call and the summary and fields a system extracted from it.

Return pass: false if any of these hold:
- the summary states something the transcript doesn't support (a detail, a cause, a promise or booking that wasn't made);
- the urgency doesn't follow the rules below;
- the summary leaves out the main reason the caller rang;
- a field (name, number, postcode) contradicts the transcript, or was filled in when the caller never gave it.
Return pass: true otherwise. Minor rewording is fine. A null field is never a hallucination.
Numbers: the system stores UK numbers in international form, so a caller's "07700 900112" and a field of +447700900112 are the same number, and that's a match.
Write your reason first, checking each point above in a sentence or two, then give pass. The verdict must agree with your reason: if your checking finds nothing wrong, pass is true.

The urgency is set by these rules, which are cautious on purpose, so judge it by them and not by how worried the caller sounded:
${URGENCY_RULES}`;
  const lines = transcript.map(
    (turn) => `${turn.role === "agent" ? "Assistant" : "Caller"}: ${turn.text || "[silence]"}`,
  );
  const user = `Transcript:\n${lines.join("\n")}\n\nSummary: ${extraction.jobSummary}\nUrgency: ${extraction.urgency}\nName: ${extraction.callerName ?? "null"}\nNumber: ${extraction.callbackNumber ?? "null"}\nPostcode: ${extraction.postcode ?? "null"}\nFlags: ${extraction.flags.join(", ") || "none"}`;
  return { system, user };
}

export async function judgeSummary(
  llm: LlmProvider,
  meter: CostMeter | null,
  transcript: TranscriptTurn[],
  extraction: CallExtraction,
): Promise<JudgeVerdict & { usage: LlmUsage }> {
  const result = await llm.extract({
    ...buildJudgePrompt(transcript, extraction),
    schema: judgeSchema,
  });
  meter?.add(result.usage);
  const usage = result.usage;
  if (!result.ok) {
    return { pass: false, reason: `Judge gave no usable verdict (${result.reason})`, usage };
  }
  return { ...result.value, usage };
}
