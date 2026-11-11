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

/**
 * Stored for an agent call whose transcript has no words in it (the caller rang off straight
 * away, or the platform sent none): the tradesperson still hears that someone rang.
 */
export const EMPTY_TRANSCRIPT_SUMMARY = "Nothing to summarise, the call has no transcript";

/**
 * How a call's urgency is decided: by the problem, never by how calm or pushy the caller is.
 * Shared with the eval judge (evals/judge.ts), which marked a deliberate "emergency" for a
 * calmly mentioned gas smell as unsupported when it didn't know these rules (2026-11-07).
 */
export const URGENCY_RULES = `- "emergency" if there was any mention of a gas smell or a suspected gas leak, carbon monoxide or a CO alarm, fire, smoke, sparks, a burning smell, an electric shock, exposed live wires, water that can't be stopped (a burst pipe, flooding, water pouring through a ceiling), a ceiling, wall or roof coming down, or danger to a person. Even when the caller plays it down: over-trigger on purpose.
- "urgent" if the problem can't wait: no heating, hot water, water or power at all (one cold radiator or one dead socket isn't that), water getting in that isn't pouring, someone locked out, or a property that can't be secured.
- "routine" for any other job. A caller wanting someone soon, today or at a set time doesn't make a job urgent on its own: judge the problem, not the request.
- "spam" for sales calls, robocalls or wrong numbers.
- "other" if the call wasn't about a job at all, or the caller said nothing.`;

export interface ExtractionContext {
  businessName: string;
  tradespersonName: string;
  /** The caller ID in E.164, when known: what "this number" means in the transcript. */
  callerNumber?: string | null;
}

export function buildExtractionPrompt(
  transcript: TranscriptTurn[],
  { businessName, tradespersonName, callerNumber }: ExtractionContext,
): { system: string; user: string } {
  const system = `You read transcripts of phone calls answered by an AI assistant on behalf of ${businessName}, a UK trade business run by ${tradespersonName}, and extract what ${tradespersonName} needs in order to call the customer back.

Rules:
- Use only what the caller actually said. Never guess a name, number or postcode; use null when it wasn't given or was unclear.
- callbackNumber: the number the caller wants to be rung on. If it's a UK number, write it in E.164 form (+44...). Keep it null if the digits are incomplete or doubtful.${
    callerNumber
      ? ` The caller rang from ${callerNumber}: if they agreed to be called back on the number they're calling from and gave no other, callbackNumber is ${callerNumber}.`
      : ""
  }
- postcode: as given, upper case, with the usual space (for example "LS1 4AP"). A postcode spelled out letter by letter ("L S one, four A P") counts as given: put it together. Write it even if you don't recognise the area. Null only if it wasn't given or was cut off.
- Speech recognition mangles names and postcodes: a caller's answer can appear as nonsense ("Alice fifteen seven q y" where they said a postcode; "Oh, four" where they said their name). When the caller plainly answered but the words don't make a name or a postcode, leave that field null, never a guess, and say so in jobSummary in a few words with what it sounded like, for example 'Postcode not caught: sounded like "Alice fifteen seven q y"' or 'Name not caught', so ${tradespersonName} knows to ask. If a reading is obvious, offer it there as a possibility ("possibly LS15 7QY"), still not in the field.
- jobSummary: what the job is and anything essential, in at most two short lines, written for ${tradespersonName}. No greetings, no padding. Nothing is ever booked on these calls: if the caller asked for a day or time, write it as their request ("asked if someone could come tomorrow at 9"), and never write a day, time or date as settled.
- urgency, one of:
${URGENCY_RULES}
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
