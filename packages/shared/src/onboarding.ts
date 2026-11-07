// The steps a business goes through from signing up to answering calls (BUILD_PLAN Step 11),
// in order. Shared so the API and the dashboard name them the same way.

export const ONBOARDING_STATES = [
  "created",
  "terms_accepted",
  "payment_ready",
  "number_provisioned",
  "profile_complete",
  "agent_synced",
  "divert_instructions_sent",
  "test_call_received",
  "live",
] as const;

export type OnboardingState = (typeof ONBOARDING_STATES)[number];

export const ONBOARDING_LABELS: Record<OnboardingState, string> = {
  created: "Signed up",
  terms_accepted: "Terms accepted",
  payment_ready: "Payment set up",
  number_provisioned: "Number bought",
  profile_complete: "Details complete",
  agent_synced: "Assistant set up",
  divert_instructions_sent: "Divert instructions sent",
  test_call_received: "Test call received",
  live: "Live",
};

/** GET /api/admin/tenants/:id/onboarding: one business's checklist. */
export interface OnboardingView {
  state: OnboardingState;
  isPilot: boolean;
  /** Every step, in order, and whether it's behind the business. */
  steps: { state: OnboardingState; label: string; done: boolean }[];
  /** The step after this one, and whether it can be taken now (and if not, why not). */
  next: { state: OnboardingState; label: string; allowed: boolean; reason: string | null } | null;
  /** What the system can see, in words: the facts the steps depend on. */
  checks: { label: string; ok: boolean }[];
}
