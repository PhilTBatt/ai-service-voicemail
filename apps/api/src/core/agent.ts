// The provider-neutral description of a tenant's phone agent. The prompt builder (core)
// produces it from a profile and a trade template; a VoiceProvider adapter turns it into a
// platform agent. Nothing here may mention a specific platform.

/** A message spoken exactly as written, which the caller can't talk over. */
export interface FixedScript {
  id: "gas_emergency" | "danger" | "water_leak" | "are_you_ai";
  /** When to speak it, in plain language for the model. Over-trigger on purpose. */
  trigger: string;
  text: string;
}

export interface AgentLimits {
  maxCallSeconds: number;
  /** After this much silence, prompt the caller once... */
  silenceReminderSeconds: number;
  /** ...and after this much, end the call. */
  endAfterSilenceSeconds: number;
  /** Pause before the first words, so the audio path is ready (decision 007). */
  beginMessageDelayMs: number;
}

export interface AgentDefinition {
  tenantId: string;
  profileVersion: number;
  language: "en-GB";
  timezone: "Europe/London";
  voice: { gender: "female" | "male" };
  /** Spoken first, exactly, uninterruptible: the AI and recording disclosure. */
  opening: string;
  /** Everything the model is told: what to collect, the rules, FAQs, hours wording. */
  instructions: string;
  /** Spoken exactly when triggered, then the call carries on; re-spoken if dismissed. */
  scripts: FixedScript[];
  /** Spoken exactly, then the call ends. */
  close: string;
  limits: AgentLimits;
}
