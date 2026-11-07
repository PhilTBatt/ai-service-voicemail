import { describe, expect, it } from "vitest";
import { agentProfileInputSchema, type AgentProfileInput } from "./profile.ts";

const PROFILE: AgentProfileInput = {
  trade: "plumber",
  services: ["Boiler repairs", "Burst pipes"],
  serviceAreas: ["Leeds", "Bradford"],
  openingHours: { mon: { open: "08:00", close: "18:00" }, sun: null },
  holidayMode: false,
  holidayUntil: null,
  faqs: [
    {
      question: "How much do you charge?",
      answer: "Sam will talk you through costs when he calls back.",
    },
  ],
  emergencyPolicy: { takesEmergencyCalls: true },
};

/** The messages zod gives for a profile, keyed by the path of the field. */
function problems(profile: unknown): Record<string, string[]> {
  const result = agentProfileInputSchema.safeParse(profile);
  if (result.success) return {};
  const byPath: Record<string, string[]> = {};
  for (const issue of result.error.issues) {
    (byPath[issue.path.join(".")] ??= []).push(issue.message);
  }
  return byPath;
}

describe("agentProfileInputSchema", () => {
  it("accepts a sensible profile, and a question that asks about price", () => {
    expect(problems(PROFILE)).toEqual({});
  });

  it("refuses prices in anything the agent would say", () => {
    expect(problems({ ...PROFILE, services: ["Boiler service £80"] })).toEqual({
      "services.0": ["can't include prices: the assistant never quotes them"],
    });
    const faq = { question: "Do you do free quotes?", answer: "Yes, quotes are free of charge." };
    expect(problems({ ...PROFILE, faqs: [faq] })).toEqual({
      "faqs.0.answer": ["can't include prices: the assistant never quotes them"],
    });
  });

  it("refuses promised times in an FAQ answer", () => {
    const faq = {
      question: "How quickly can you come?",
      answer: "We're with you within the hour.",
    };
    expect(problems({ ...PROFILE, faqs: [faq] })).toEqual({
      "faqs.0.answer": ["can't promise a time: the assistant never commits to one"],
    });
  });

  it("trims text and refuses lines that are only spaces", () => {
    const parsed = agentProfileInputSchema.parse({ ...PROFILE, services: ["  Boiler repairs  "] });
    expect(parsed.services).toEqual(["Boiler repairs"]);
    expect(problems({ ...PROFILE, serviceAreas: ["   "] })).toEqual({
      "serviceAreas.0": ["can't be empty"],
    });
  });

  it("caps the lists and the text lengths", () => {
    const many = Array.from({ length: 26 }, (_, i) => `Job ${i}`);
    expect(problems({ ...PROFILE, services: many })).toEqual({ services: ["25 at most"] });
    expect(problems({ ...PROFILE, services: ["x".repeat(81)] })).toEqual({
      "services.0": ["keep it under 80 characters"],
    });
  });

  it("keeps opening hours within a day and holiday dates as dates", () => {
    expect(
      problems({ ...PROFILE, openingHours: { mon: { open: "18:00", close: "08:00" } } }),
    ).toEqual({ "openingHours.mon": ["close must be after open"] });
    expect(problems({ ...PROFILE, holidayMode: true, holidayUntil: "next week" })).toHaveProperty(
      "holidayUntil",
    );
  });
});
