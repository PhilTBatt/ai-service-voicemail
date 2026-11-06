import { describe, expect, it } from "vitest";
import { buildExtractionPrompt, callExtractionSchema } from "./extraction.ts";

const VALID = {
  callerName: "Sam",
  callbackNumber: "+447700900123",
  postcode: "XQ12 3JL",
  jobSummary: "Boiler leaking.",
  urgency: "urgent",
  priceAsked: true,
  flags: [],
};

describe("callExtractionSchema", () => {
  it("accepts a full extraction and one with everything unknown", () => {
    expect(callExtractionSchema.safeParse(VALID).success).toBe(true);
    expect(
      callExtractionSchema.safeParse({
        ...VALID,
        callerName: null,
        callbackNumber: null,
        postcode: null,
      }).success,
    ).toBe(true);
  });

  it.each([
    ["an unknown urgency", { urgency: "panic" }],
    ["an empty summary", { jobSummary: "" }],
    ["a missing priceAsked", { priceAsked: undefined }],
    ["too many flags", { flags: Array.from({ length: 11 }, (_, i) => `f${i}`) }],
  ])("rejects %s", (_label, bad) => {
    expect(callExtractionSchema.safeParse({ ...VALID, ...bad }).success).toBe(false);
  });
});

describe("buildExtractionPrompt", () => {
  it("names the business and tradesperson, states the rules, and lays the transcript out by speaker", () => {
    const { system, user } = buildExtractionPrompt(
      [
        { role: "agent", text: "Hi there." },
        { role: "caller", text: "Hello." },
      ],
      { businessName: "Ant's Plumbing", tradespersonName: "Ant" },
    );
    expect(system).toContain("Ant's Plumbing");
    expect(system).toContain("Never guess a name, number or postcode");
    expect(system).toContain('"emergency" if there was any mention of gas');
    expect(user).toBe("Transcript:\n\nAssistant: Hi there.\nCaller: Hello.");
  });
});
