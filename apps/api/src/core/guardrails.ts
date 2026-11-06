// Post-call guardrail scan (BUILD_PLAN Step 5): the managed platform can't filter what the
// agent says in real time, so the agent's turns are checked afterwards for the two things
// it must never do: quote prices and commit to times. A match flags the call for review.
import type { TranscriptTurn } from "../providers/voice.ts";

export interface GuardrailHit {
  rule: "price" | "commitment";
  /** The agent's words that matched, trimmed, for the review queue. */
  excerpt: string;
}

const PRICE_PATTERNS: RegExp[] = [
  /£\s?\d/, // £80, £ 80
  /\d+\s?(?:pounds?|quid)\b/i,
  /\b(?:ninety|eighty|seventy|sixty|fifty|forty|thirty|twenty|hundred|thousand)\b[^.]{0,20}\b(?:pounds?|quid)\b/i,
  /\b(?:call-?out (?:fee|charge) (?:is|of|would be))\b/i,
  /\b(?:it(?:'ll| will) (?:cost|be) (?:about |around |roughly )?(?:£|\d))/i,
  /\b(?:costs?|charges?|rates?) (?:is|are|would be|start(?:s)? (?:at|from)) (?:about |around |roughly )?(?:£|\d)/i,
  /\bper hour\b.{0,10}\d|\d.{0,10}\bper hour\b/i,
  /\bfree of charge\b|\bno charge\b|\bwon't charge\b/i,
];

const COMMITMENT_PATTERNS: RegExp[] = [
  /\b(?:he|she|they|[A-Z][a-z]+)(?: will| ?'ll| can| could) (?:be (?:there|with you|round|out)|come(?: round| out)?|visit|pop (?:round|over|in)|call (?:you )?back)\b[^.]{0,40}\b(?:today|tomorrow|tonight|this (?:morning|afternoon|evening)|within (?:the|an?) (?:hour|\d+ (?:hours|minutes))|in (?:an?|\d+) (?:hour|hours|minutes)|at \d|by \d|on (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i,
  /\b(?:i(?:'ll| will) book|i(?:'ve| have) booked|booked you in|book you in|put you in (?:for|the diary))\b/i,
  /\b(?:appointment|slot|visit) (?:is |for |at |on |will be )+(?:\d|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i,
  /\b(?:guarantee|promise)\b[^.]{0,30}\b(?:today|tomorrow|tonight|within|by \d|an hour)\b/i,
  /\bwithin (?:the|an?) hour\b|\bwithin \d+ (?:minutes|hours)\b/i,
];

/** Scans only the agent's turns. Callers can say what they like. */
export function scanAgentTurns(transcript: TranscriptTurn[]): GuardrailHit[] {
  const hits: GuardrailHit[] = [];
  for (const turn of transcript) {
    if (turn.role !== "agent") continue;
    for (const sentence of turn.text.split(/(?<=[.!?])\s+/)) {
      // A sentence can break both rules; record each.
      if (PRICE_PATTERNS.some((p) => p.test(sentence))) {
        hits.push({ rule: "price", excerpt: sentence.trim().slice(0, 160) });
      }
      if (COMMITMENT_PATTERNS.some((p) => p.test(sentence))) {
        hits.push({ rule: "commitment", excerpt: sentence.trim().slice(0, 160) });
      }
    }
  }
  return hits;
}
