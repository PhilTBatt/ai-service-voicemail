// Which of a call's flags the tradesperson sees. A call carries two kinds: the pipeline's own,
// for the admin's review queue (the agent may have named a price or given advice, the summary
// was doubted or failed: apps/api/src/core/review.ts), and the summary's notes about the caller
// ("mentioned gas smell", "caller abusive"). The first kind is about how our service behaved,
// not about the caller, and showed as red badges on the tradesperson's call page. Phil's
// decision (2026-11-11): the admin sees every flag; the tradesperson, only the notes.

/** The pipeline's flags start with these (`guardrail:price`, `judge:failed`). */
const INTERNAL_PREFIXES = ["guardrail:", "judge:"] as const;
/** And this one has no prefix: no summary, so the tradesperson was told to read the transcript. */
const INTERNAL_FLAGS: ReadonlySet<string> = new Set(["extraction_failed"]);

/** True for a flag that's for the admin's review queue, never for the tradesperson. */
export function isInternalFlag(flag: string): boolean {
  return INTERNAL_FLAGS.has(flag) || INTERNAL_PREFIXES.some((prefix) => flag.startsWith(prefix));
}

/**
 * Flags the system sets that the tradesperson should see, in words: a safety message played
 * during the call (db/calls.ts recordMidCallEmergency sets `emergency:<kind>`).
 */
const FLAG_WORDS: Readonly<Record<string, string>> = {
  "emergency:gas": "Gas safety message given",
  "emergency:danger": "999 safety message given",
};

/**
 * The flags a tradesperson sees on a call, in their order: the summary's own notes as written,
 * and the system's own flags in words. Never a code like "emergency:gas": any other flag of
 * that shape (a new kind not yet given words) is left out rather than shown as jargon.
 */
export function tradespersonFlags(flags: readonly string[]): string[] {
  return flags.flatMap((flag) => {
    if (isInternalFlag(flag)) return [];
    if (Object.hasOwn(FLAG_WORDS, flag)) return [FLAG_WORDS[flag]!];
    return /^[a-z_]+:[a-z_]+$/.test(flag) ? [] : [flag];
  });
}
