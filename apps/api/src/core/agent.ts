// The provider-neutral description of a tenant's phone agent. The prompt builder (core)
// produces it from a profile and a trade template; a VoiceProvider adapter turns it into a
// platform agent. Nothing here may mention a specific platform.

/** A message spoken exactly as written, which the caller can't talk over. */
export interface FixedScript {
  id: "gas_emergency" | "danger" | "water_leak" | "are_you_ai";
  /**
   * When to speak it, in plain language for the model. Over-trigger on purpose, but on news
   * (a first mention, something worse, a warning played down), not on every turn that still
   * mentions the hazard: the condition is checked after each thing the caller says.
   */
  trigger: string;
  text: string;
  /**
   * Spoken at most once a call, whatever the model makes of the trigger: for a message that
   * says nothing new the second time. The eval run of 2026-11-08 heard the water message three
   * times in a call whose caller had said they couldn't find the stopcock.
   */
  oncePerCall?: boolean;
}

export interface AgentLimits {
  maxCallSeconds: number;
  /** When to start wrapping the call up (Appendix B: 6 minutes, with the cap at 8). */
  wrapUpAfterSeconds: number;
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
  /**
   * When to move to the close, in plain language for the model: one wording for the platform's
   * flow and the eval simulation alike.
   */
  closeWhen: string;
  /**
   * Values our server supplies for each call (whether the business is open right now, and
   * so on). The instructions refer to them as {{name}}.
   */
  perCallVariables: { name: string; description: string }[];
  limits: AgentLimits;
}
