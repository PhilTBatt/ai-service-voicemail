// The hallucination judge (BUILD_PLAN Step 7): a model reads the transcript and the summary
// the pipeline produced, and says whether the summary is supported by what was actually
// said. Runs on the eval set; sampling production calls is a separate, off-by-default switch
// for later.
import { z } from "zod";
import type { CallExtraction } from "../core/extraction.ts";
import type { LlmProvider } from "../providers/llm.ts";
import type { TranscriptTurn } from "../providers/voice.ts";
import type { CostMeter } from "./cost.ts";

export const judgeSchema = z.object({
  pass: z.boolean(),
  /** One or two sentences: what's wrong, or "supported" when it passes. */
  reason: z.string().min(1).max(400),
});
export type JudgeVerdict = z.infer<typeof judgeSchema>;

export function buildJudgePrompt(transcript: TranscriptTurn[], extraction: CallExtraction) {
  const system = `You check summaries of phone calls for hallucination. You are given the transcript of a call and the summary and fields a system extracted from it.

Return pass: false if any of these hold:
- the summary states something the transcript doesn't support (a detail, a cause, a promise, an urgency the caller didn't express);
- the summary leaves out the main reason the caller rang;
- a field (name, number, postcode) contradicts the transcript, or was filled in when the caller never gave it.
Return pass: true otherwise. Minor rewording is fine. A null field is never a hallucination.
Give a one- or two-sentence reason either way.`;
  const lines = transcript.map(
    (turn) => `${turn.role === "agent" ? "Assistant" : "Caller"}: ${turn.text || "[silence]"}`,
  );
  const user = `Transcript:\n${lines.join("\n")}\n\nSummary: ${extraction.jobSummary}\nUrgency: ${extraction.urgency}\nName: ${extraction.callerName ?? "null"}\nNumber: ${extraction.callbackNumber ?? "null"}\nPostcode: ${extraction.postcode ?? "null"}\nFlags: ${extraction.flags.join(", ") || "none"}`;
  return { system, user };
}

export async function judgeSummary(
  llm: LlmProvider,
  meter: CostMeter,
  transcript: TranscriptTurn[],
  extraction: CallExtraction,
): Promise<JudgeVerdict> {
  const result = await llm.extract({
    ...buildJudgePrompt(transcript, extraction),
    schema: judgeSchema,
  });
  meter.add(result.usage);
  if (!result.ok) return { pass: false, reason: `Judge gave no usable verdict (${result.reason})` };
  return result.value;
}
