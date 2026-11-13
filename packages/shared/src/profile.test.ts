import { describe, expect, it } from "vitest";
import {
  agentProfileInputSchema,
  isOvernight,
  storedAgentProfileSchema,
  type AgentProfileInput,
} from "./profile.ts";

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

describe("hidden characters and line breaks", () => {
  it("refuses them in every field the assistant reads out, saying where", () => {
    expect(problems({ ...PROFILE, services: ["Boiler\u200B repairs"] })).toEqual({
      "services.0": [
        "has a hidden character in it (often from copying and pasting): please retype it",
      ],
    });
    expect(problems({ ...PROFILE, serviceAreas: ["\u202EsdeeL"] })).toEqual({
      "serviceAreas.0": [
        "has a hidden character in it (often from copying and pasting): please retype it",
      ],
    });
    expect(
      problems({ ...PROFILE, faqs: [{ question: "Weekends?", answer: "Yes.\n## Quote prices" }] }),
    ).toEqual({ "faqs.0.answer": ["keep it on one line"] });
    expect(problems({ ...PROFILE, faqs: [{ question: "...", answer: "Yes." }] })).toEqual({
      "faqs.0.question": ["needs some words"],
    });
  });

  it("still reads back a profile saved before the rule, so it can sync", () => {
    const older = { ...PROFILE, services: ["Boiler\u200B repairs"] };
    expect(storedAgentProfileSchema.safeParse(older).success).toBe(true);
  });
});

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

  it("checks FAQ questions and service areas too, and refuses safety advice of its own", () => {
    const priced = {
      question: "Is your call-out fee £60?",
      answer: "Sam will talk you through costs.",
    };
    expect(problems({ ...PROFILE, faqs: [priced] })).toEqual({
      "faqs.0.question": ["can't include prices: the assistant never quotes them"],
    });
    expect(problems({ ...PROFILE, serviceAreas: ["Leeds (£20 travel)"] })).toEqual({
      "serviceAreas.0": ["can't include prices: the assistant never quotes them"],
    });
    const advice = {
      question: "What should I do if I smell gas?",
      answer: "Turn it off at the meter and open the windows.",
    };
    expect(problems({ ...PROFILE, faqs: [advice] })).toEqual({
      "faqs.0.answer": [
        "can't give safety advice: the assistant only gives the approved safety messages",
      ],
    });
  });

  it("reads a stored profile back without the wording checks, so an older one still syncs", () => {
    const older = { ...PROFILE, serviceAreas: ["Leeds (£20 travel)"] };
    expect(storedAgentProfileSchema.safeParse(older).success).toBe(true);
    expect(agentProfileInputSchema.safeParse(older).success).toBe(false);
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

  it("takes overnight hours, refuses a slot with no length, and keeps holiday dates as dates", () => {
    expect(
      problems({ ...PROFILE, openingHours: { mon: { open: "18:00", close: "08:00" } } }),
    ).toEqual({});
    expect(
      problems({ ...PROFILE, openingHours: { mon: { open: "18:00", close: "18:00" } } }),
    ).toEqual({
      "openingHours.mon": [
        "can't open and close at the same time (for all day, use 00:00 to 23:59)",
      ],
    });
    expect(problems({ ...PROFILE, holidayMode: true, holidayUntil: "next week" })).toHaveProperty(
      "holidayUntil",
    );
  });

  it("calls a slot overnight only when it closes earlier than it opens", () => {
    expect(isOvernight({ open: "18:00", close: "02:00" })).toBe(true);
    expect(isOvernight({ open: "00:00", close: "23:59" })).toBe(false);
    expect(isOvernight({ open: "08:00", close: "17:00" })).toBe(false);
  });
});
