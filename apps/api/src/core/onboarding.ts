// The onboarding state machine (BUILD_PLAN Step 11). Pure rules: the database facts come in,
// a yes or a no (with the reason, in words) goes out. db/onboarding.ts applies them.
//
// A business moves one step at a time, forwards only, and only once that step's condition
// holds. Most conditions are facts the system can check; sending the divert instructions is
// confirmed by an admin until Step 11 sends them itself.
import { ONBOARDING_LABELS, ONBOARDING_STATES, type OnboardingState } from "@callmate/shared";

export interface OnboardingFacts {
  /** All three documents accepted: terms, DPA and privacy notice. */
  termsAccepted: boolean;
  /**
   * The versions accepted are the solicitor-approved ones. Until Phil uploads them they're
   * placeholders, and only a test business may go live (BUILD_PLAN Step 11 🛑).
   */
  documentsApproved: boolean;
  /** Signed up from a test link: Phil trying the service out. */
  isTest: boolean;
  /** A Direct Debit is set up to collect against (Step 12). */
  paymentReady: boolean;
  /** A free pilot: allowed past "payment set up" without one (BUILD_PLAN Step 11). */
  isPilot: boolean;
  hasNumber: boolean;
  /** A saved assistant profile, the tradesperson's name, and a mobile for texts. */
  profileComplete: boolean;
  /** The latest profile version is live on the voice platform. */
  agentSynced: boolean;
  /** A call has reached the business's number. */
  testCallReceived: boolean;
}

export type Verdict = { ok: true } | { ok: false; reason: string };

export function nextState(state: OnboardingState): OnboardingState | null {
  const index = ONBOARDING_STATES.indexOf(state);
  return ONBOARDING_STATES[index + 1] ?? null;
}

/**
 * The go-live rule: accepted terms (approved ones, unless it's a test business), payment ready
 * (or a pilot), and a test call. Checked again
 * at the last step even though earlier steps implied it, because those facts can change.
 */
export function goLiveVerdict(facts: OnboardingFacts): Verdict {
  if (!facts.termsAccepted) return { ok: false, reason: "The terms haven't all been accepted" };
  if (!facts.documentsApproved && !facts.isTest) {
    return {
      ok: false,
      reason: "The legal documents are still placeholders, so only a test business can go live",
    };
  }
  if (!facts.paymentReady && !facts.isPilot) {
    return { ok: false, reason: "No Direct Debit is set up, and this isn't a pilot" };
  }
  if (!facts.testCallReceived) return { ok: false, reason: "No test call has been received" };
  return { ok: true };
}

function conditionFor(to: OnboardingState, facts: OnboardingFacts): Verdict {
  const unless = (ok: boolean, reason: string): Verdict =>
    ok ? { ok: true } : { ok: false, reason };
  switch (to) {
    case "created":
      return { ok: false, reason: "Every business starts here; nothing moves back to it" };
    case "terms_accepted":
      return unless(
        facts.termsAccepted,
        "The terms, DPA and privacy notice haven't all been accepted",
      );
    case "payment_ready":
      return unless(
        facts.paymentReady || facts.isPilot,
        "No Direct Debit is set up, and this isn't a pilot",
      );
    case "number_provisioned":
      return unless(facts.hasNumber, "There's no AnswerMate number yet");
    case "profile_complete":
      return unless(
        facts.profileComplete,
        "The assistant's details, the tradesperson's name and a mobile for texts are all needed",
      );
    case "agent_synced":
      return unless(facts.agentSynced, "The assistant hasn't picked up the latest details yet");
    case "divert_instructions_sent":
      return { ok: true }; // an admin confirms they were sent
    case "test_call_received":
      return unless(facts.testCallReceived, "No call has reached the number yet");
    case "live":
      return goLiveVerdict(facts);
  }
}

/** Whether a business at `from` may move to `to` now. */
export function canAdvance(
  from: OnboardingState,
  to: OnboardingState,
  facts: OnboardingFacts,
): Verdict {
  const next = nextState(from);
  if (next === null) return { ok: false, reason: "Already live" };
  if (to !== next) {
    return {
      ok: false,
      reason: `Onboarding moves one step at a time: after "${ONBOARDING_LABELS[from]}" comes "${ONBOARDING_LABELS[next]}"`,
    };
  }
  return conditionFor(to, facts);
}
