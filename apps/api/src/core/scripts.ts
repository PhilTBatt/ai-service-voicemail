// The call scripts from BUILD_PLAN Appendix A. They're spoken exactly as written; only the
// names and the region's number change. Phil approves the wording before go-live (Step 7).

export const GAS_EMERGENCY_NUMBER = {
  GB: "0800 111 999",
  // From a secondary source in the research. Phil verifies it before any NI tenant goes live.
  NI: "0800 002 001",
} as const;

export interface ScriptNames {
  business: string;
  tradesperson: string;
}

/** Appendix A's opening, plus a question (Phil, 2026-11-06): without one the agent fell
 * silent after the disclosure and callers didn't know it was their turn. */
export function openingLine({ business, tradesperson }: ScriptNames): string {
  return `Hi, you're through to ${business}. I'm their AI assistant. This call is recorded and transcribed so ${tradesperson} can call you back. How can I help?`;
}

export function gasScript(tradesperson: string, region: keyof typeof GAS_EMERGENCY_NUMBER): string {
  const number = GAS_EMERGENCY_NUMBER[region];
  return `If you can smell gas, or you think there's carbon monoxide, please call the National Gas Emergency Service now on ${number}. It's free and open 24 hours a day. Don't smoke, don't use naked flames, and don't touch electrical switches. Open doors and windows, and turn the gas off at the meter if it's safe to and the meter isn't in a cellar. The number again is ${number}. I'll text it to you now and let ${tradesperson} know straight away.`;
}

export const DANGER_SCRIPT =
  "If anyone is in danger, or there's a fire or smoke, please hang up now and call 999.";

export function waterScript(tradesperson: string): string {
  return `If it's safe to, turn off your water at the stopcock. I'm marking this as urgent for ${tradesperson} now.`;
}

export function areYouAiLine({ business, tradesperson }: ScriptNames): string {
  return `Yes, I'm an AI assistant for ${business}. I'll make sure ${tradesperson} gets your message.`;
}

/** Appendix A names the caller ("Thanks, {Caller}"). Fixed text can't safely include a name
 * the model only heard, so it's left out. No times, no promises. */
export function closingLine(tradesperson: string): string {
  return `Thanks. I've passed that to ${tradesperson}, who'll aim to get back to you.`;
}
