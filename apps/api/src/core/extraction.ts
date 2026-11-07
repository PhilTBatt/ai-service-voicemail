// What the post-call pipeline pulls out of a transcript (BUILD_PLAN Step 5), and the
// prompt that asks for it. Provider-neutral: the LLM adapter only sees a prompt and a schema.
import { z } from "zod";
import type { TranscriptTurn } from "../providers/voice.ts";

export const URGENCIES = ["emergency", "urgent", "routine", "spam", "other"] as const;

export const callExtractionSchema = z.object({
  callerName: z.string().min(1).nullable(),
  /** As the caller gave it, normalised to E.164 when it's clearly a UK number. */
  callbackNumber: z.string().nullable(),
  postcode: z.string().nullable(),
  /** At most two short lines. */
  jobSummary: z.string().min(1).max(300),
  urgency: z.enum(URGENCIES),
  priceAsked: z.boolean(),
  /** Anything the tradesperson should know, such as "mentioned gas smell", "caller abusive". */
  flags: z.array(z.string().min(1)).max(10),
});
export type CallExtraction = z.infer<typeof callExtractionSchema>;

/** Stored when extraction fails for good (invalid output twice); the transcript is still there. */
export const EXTRACTION_FAILED_SUMMARY = "Couldn't summarise, see the transcript";

export interface ExtractionContext {
  businessName: string;
  tradespersonName: string;
}

export function buildExtractionPrompt(
  transcript: TranscriptTurn[],
  { businessName, tradespersonName }: ExtractionContext,
): { system: string; user: string } {
  const system = `You read transcripts of phone calls answered by an AI assistant on behalf of ${businessName}, a UK trade business run by ${tradespersonName}, and extract what ${tradespersonName} needs in order to call the customer back.

Rules:
- Use only what the caller actually said. Never guess a name, number or postcode; use null when it wasn't given or was unclear.
- callbackNumber: the number the caller wants to be rung on. If it's a UK number, write it in E.164 form (+44...). Keep it null if the digits are incomplete or doubtful.
- postcode: as given, upper case, with the usual space (for example "LS1 4AP"). Null if not given.
- jobSummary: what the job is and anything essential, in at most two short lines, written for ${tradespersonName}. No greetings, no padding.
- urgency: "emergency" if there was any mention of gas, carbon monoxide, fire, smoke, sparks, flooding or danger to a person; "urgent" if the caller needs someone today or has no heating, water or power; "routine" otherwise; "spam" for sales calls, robocalls or wrong numbers; "other" if the call wasn't about a job at all.
- priceAsked: true if the caller asked about cost or a quote at any point.
- flags: short notes ${tradespersonName} should see, such as "mentioned gas smell", "existing customer chasing a job", "caller abusive", "call cut off". Empty if nothing stands out.`;

  const lines = transcript.map(
    (turn) => `${turn.role === "agent" ? "Assistant" : "Caller"}: ${turn.text}`,
  );
  const user = `Transcript:\n\n${lines.join("\n")}`;
  return { system, user };
}

/**
 * What the notification jobs read back from calls.extracted_fields: the contact details only,
 * tolerant of anything else stored alongside them (guardrail hits, future fields).
 */
export const storedFieldsSchema = z.looseObject({
  callerName: z.string().nullable().optional(),
  callbackNumber: z.string().nullable().optional(),
  postcode: z.string().nullable().optional(),
  /** Fallback voicemails only: the recording's length. */
  recordingSeconds: z.number().int().nonnegative().optional(),
});
