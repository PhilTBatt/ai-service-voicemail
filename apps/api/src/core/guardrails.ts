// Post-call guardrail scan (BUILD_PLAN Step 5): the managed platform can't filter what the
// agent says in real time, so the agent's turns are checked afterwards for what it must never
// do: quote prices, commit to times, and give safety advice beyond the approved scripts. A
// match flags the call for review.
import {
  COMMITMENT_PATTERNS,
  PRICE_PATTERNS,
  SAFETY_ADVICE_PATTERNS,
  guardrailText,
} from "@callmate/shared";
import type { TranscriptTurn } from "../providers/voice.ts";
import { DANGER_SCRIPT, GAS_EMERGENCY_NUMBER, gasScript, waterScript } from "./scripts.ts";

export interface GuardrailHit {
  rule: "price" | "commitment" | "safety";
  /** The agent's words that matched, trimmed, for the review queue. */
  excerpt: string;
}

export interface ScanOptions {
  /**
   * The scripts' exact texts, when each is known to be spoken as a whole turn (the eval
   * simulation): those turns are skipped, and any other turn is the agent's own words. Without
   * them (a real transcript), a script is recognised from its opening sentence on.
   */
  scriptTurns?: readonly string[];
}

const sentencesOf = (text: string): string[] =>
  text.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.trim() !== "");
/** As the patterns read it (look-alikes, curly apostrophes, spacing), to compare with a script. */
const normalise = (text: string): string => guardrailText(text).trim().toLowerCase();

/**
 * Appendix A's scripts that give advice, sentence by sentence, for both regions. Built from
 * scripts.ts, so a change to the wording can't leave them behind. Their advice sentences hold
 * no name, so the stand-in doesn't matter (guardrails.test.ts speaks them with real names).
 */
const SCRIPTS: readonly string[][] = [
  ...Object.keys(GAS_EMERGENCY_NUMBER).map((region) =>
    gasScript("Name", region as keyof typeof GAS_EMERGENCY_NUMBER),
  ),
  DANGER_SCRIPT,
  waterScript("Name"),
].map((script) => sentencesOf(script).map(normalise));

/**
 * Which of a turn's sentences are a script being spoken: a run that starts at a script's
 * opening sentence and follows it in order. A script cut short counts too (a caller told to
 * ring the gas line may hang up mid-message), down to a last sentence broken off part-way.
 * One sentence lifted out of a script into the agent's own words doesn't.
 */
function scriptSentences(sentences: string[]): Set<number> {
  const inScript = new Set<number>();
  const said = sentences.map(normalise);
  let i = 0;
  while (i < said.length) {
    const script = SCRIPTS.find((candidate) => candidate[0] === said[i]);
    if (!script) {
      i += 1;
      continue;
    }
    let j = 0;
    while (j < script.length && i + j < said.length) {
      const sentence = said[i + j]!;
      const isLast = i + j === said.length - 1;
      const brokenOff = isLast && sentence.length >= 8 && script[j]!.startsWith(sentence);
      if (sentence !== script[j] && !brokenOff) break;
      inScript.add(i + j);
      j += 1;
    }
    i += Math.max(j, 1);
  }
  return inScript;
}

/** Scans only the agent's turns. Callers can say what they like. */
export function scanAgentTurns(
  transcript: TranscriptTurn[],
  { scriptTurns }: ScanOptions = {},
): GuardrailHit[] {
  const wholeScripts = scriptTurns ? new Set(scriptTurns.map(normalise)) : null;
  const hits: GuardrailHit[] = [];
  for (const turn of transcript) {
    if (turn.role !== "agent") continue;
    if (wholeScripts?.has(normalise(turn.text))) continue;
    const sentences = sentencesOf(turn.text);
    const fromScripts = wholeScripts ? new Set<number>() : scriptSentences(sentences);
    sentences.forEach((sentence, index) => {
      if (fromScripts.has(index)) return;
      // The excerpt as said; the match on the normalised text, so a full-width "￡５０" is a price.
      const excerpt = sentence.trim().slice(0, 160);
      const plain = guardrailText(sentence);
      // A sentence can break more than one rule; record each.
      if (PRICE_PATTERNS.some((p) => p.test(plain))) hits.push({ rule: "price", excerpt });
      if (COMMITMENT_PATTERNS.some((p) => p.test(plain))) {
        hits.push({ rule: "commitment", excerpt });
      }
      if (SAFETY_ADVICE_PATTERNS.some((p) => p.test(plain))) hits.push({ rule: "safety", excerpt });
    });
  }
  return hits;
}
