import {
  MOBILE_NETWORK_KEYS,
  ONBOARDING_STATES,
  divertInstructionsText,
  type OnboardingState,
} from "@callmate/shared";
import { describe, expect, it } from "vitest";
import { canAdvance, goLiveVerdict, nextState, type OnboardingFacts } from "./onboarding.ts";
import { smsEncoding, toGsm7 } from "./sms.ts";

/** Every fact in place, except that payment and pilot are tested on their own. */
const EVERYTHING: OnboardingFacts = {
  termsAccepted: true,
  documentsApproved: true,
  isTest: false,
  paymentReady: true,
  isPilot: false,
  hasNumber: true,
  profileComplete: true,
  agentSynced: true,
  testCallReceived: true,
};

const before = (state: OnboardingState) => ONBOARDING_STATES[ONBOARDING_STATES.indexOf(state) - 1]!;

describe("canAdvance: every legal and illegal transition", () => {
  it("allows exactly one step forward from each state, and nothing else", () => {
    for (const from of ONBOARDING_STATES) {
      for (const to of ONBOARDING_STATES) {
        const legal = ONBOARDING_STATES.indexOf(to) === ONBOARDING_STATES.indexOf(from) + 1;
        expect(canAdvance(from, to, EVERYTHING).ok, `${from} → ${to}`).toBe(legal);
      }
    }
  });

  it("says which step comes next when one is skipped or reversed", () => {
    expect(canAdvance("created", "live", EVERYTHING)).toEqual({
      ok: false,
      reason: 'Onboarding moves one step at a time: after "Signed up" comes "Terms accepted"',
    });
    expect(canAdvance("agent_synced", "terms_accepted", EVERYTHING).ok).toBe(false);
    expect(canAdvance("live", "live", EVERYTHING)).toEqual({ ok: false, reason: "Already live" });
    expect(nextState("live")).toBeNull();
  });

  it("holds each checked step until its condition is met", () => {
    const conditions: [OnboardingState, keyof OnboardingFacts][] = [
      ["terms_accepted", "termsAccepted"],
      ["number_provisioned", "hasNumber"],
      ["profile_complete", "profileComplete"],
      ["agent_synced", "agentSynced"],
      ["test_call_received", "testCallReceived"],
    ];
    for (const [to, fact] of conditions) {
      expect(canAdvance(before(to), to, { ...EVERYTHING, [fact]: false }).ok, to).toBe(false);
      expect(canAdvance(before(to), to, EVERYTHING).ok, to).toBe(true);
    }
  });

  it("lets a pilot past payment without a payment method, and nobody else", () => {
    const noPayment = { ...EVERYTHING, paymentReady: false };
    expect(canAdvance("terms_accepted", "payment_ready", noPayment).ok).toBe(false);
    expect(canAdvance("terms_accepted", "payment_ready", { ...noPayment, isPilot: true }).ok).toBe(
      true,
    );
  });

  it("takes an admin's word that the divert instructions were sent", () => {
    const nothing: OnboardingFacts = {
      termsAccepted: false,
      documentsApproved: false,
      isTest: false,
      paymentReady: false,
      isPilot: false,
      hasNumber: false,
      profileComplete: false,
      agentSynced: false,
      testCallReceived: false,
    };
    expect(canAdvance("agent_synced", "divert_instructions_sent", nothing).ok).toBe(true);
  });
});

describe("going live", () => {
  it("is blocked without a test call", () => {
    const noCall = { ...EVERYTHING, testCallReceived: false };
    expect(goLiveVerdict(noCall)).toEqual({ ok: false, reason: "No test call has been received" });
    expect(canAdvance("test_call_received", "live", noCall).ok).toBe(false);
  });

  it("is blocked without accepted terms, or without payment unless it's a pilot", () => {
    expect(goLiveVerdict({ ...EVERYTHING, termsAccepted: false }).ok).toBe(false);
    expect(goLiveVerdict({ ...EVERYTHING, paymentReady: false }).ok).toBe(false);
    expect(goLiveVerdict({ ...EVERYTHING, paymentReady: false, isPilot: true }).ok).toBe(true);
    expect(canAdvance("test_call_received", "live", EVERYTHING).ok).toBe(true);
  });
});

describe("going live on placeholder documents", () => {
  it("is only for a test business", () => {
    const placeholders = { ...EVERYTHING, documentsApproved: false };
    expect(goLiveVerdict(placeholders)).toEqual({
      ok: false,
      reason: "The legal documents are still placeholders, so only a test business can go live",
    });
    expect(goLiveVerdict({ ...placeholders, isTest: true }).ok).toBe(true);
  });
});

describe("the divert instructions text", () => {
  it("fits in three GSM-7 segments for every network, even with a long dashboard address", () => {
    const steps =
      "https://dashboard.answermate.example.co.uk/tenants/0b6d2c2e-8c5f-4d43-9c4b-0d8c2f9b7a11/phone";
    for (const network of [...MOBILE_NETWORK_KEYS, null]) {
      const text = toGsm7(divertInstructionsText(network, "+441134960150", steps));
      expect(smsEncoding(text).encoding, String(network)).toBe("GSM-7");
      expect(smsEncoding(text).segments, String(network)).toBeLessThanOrEqual(3);
    }
  });
});
