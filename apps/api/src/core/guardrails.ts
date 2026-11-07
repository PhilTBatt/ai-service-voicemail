// Post-call guardrail scan (BUILD_PLAN Step 5): the managed platform can't filter what the
// agent says in real time, so the agent's turns are checked afterwards for the two things
// it must never do: quote prices and commit to times. A match flags the call for review.
import { COMMITMENT_PATTERNS, PRICE_PATTERNS } from "@callmate/shared";
import type { TranscriptTurn } from "../providers/voice.ts";

export interface GuardrailHit {
  rule: "price" | "commitment";
  /** The agent's words that matched, trimmed, for the review queue. */
  excerpt: string;
}

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
