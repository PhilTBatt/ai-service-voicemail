// Whether the agent spoke one of Appendix A's emergency scripts, read from the stored
// transcript ("agent: ..." lines). A spoken script means an emergency, whatever the summary
// says: a caller told to "hang up now and call 999" often does, before the platform's own
// emergency step fires, and the extraction can misjudge or fail (over-trigger on purpose).
import { DANGER_SCRIPT } from "./scripts.ts";

/** Words only the danger script says, checked against it in spoken-scripts.test.ts. */
export const DANGER_SCRIPT_KEY = "hang up now and call 999";

const agentLines = (transcript: string | null): string[] =>
  transcript === null ? [] : transcript.split("\n").filter((line) => /^agent: /i.test(line));

/** The agent spoke the gas script: the only case where the caller gets a text too. */
export function gasScriptSpoken(transcript: string | null): boolean {
  return agentLines(transcript).some((line) => /National Gas Emergency Service/i.test(line));
}

/** The agent spoke the danger script: fire, smoke, or someone in danger. */
export function dangerScriptSpoken(transcript: string | null): boolean {
  return agentLines(transcript).some((line) => line.toLowerCase().includes(DANGER_SCRIPT_KEY));
}

export function emergencyScriptSpoken(transcript: string | null): boolean {
  return gasScriptSpoken(transcript) || dangerScriptSpoken(transcript);
}

// Referenced so a change to the script's wording that drops the key is caught at once.
export const DANGER_SCRIPT_TEXT = DANGER_SCRIPT;
