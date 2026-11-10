import { describe, expect, it } from "vitest";
import { URGENCY_RULES, buildExtractionPrompt, callExtractionSchema } from "./extraction.ts";

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
    expect(system).toContain(URGENCY_RULES);
    expect(user).toBe("Transcript:\n\nAssistant: Hi there.\nCaller: Hello.");
  });

  // The eval run of 2026-11-07: "water pouring through my kitchen ceiling" came out urgent, and
  // a dripping tap whose caller wanted a call today came out urgent too.
  it("names every emergency the scripts cover, and judges urgency by the problem, not the request", () => {
    for (const emergency of [
      "a gas smell",
      "a suspected gas leak",
      "a CO alarm",
      "a burning smell",
      "an electric shock",
      "exposed live wires",
      "water pouring through a ceiling",
      "a ceiling, wall or roof coming down",
      "danger to a person",
    ]) {
      expect(URGENCY_RULES).toContain(emergency);
    }
    expect(URGENCY_RULES).toContain("Even when the caller plays it down");
    expect(URGENCY_RULES).toContain("judge the problem, not the request");
  });

  it("tells the model nothing was booked, so a requested time isn't written up as agreed", () => {
    const { system } = buildExtractionPrompt([], { businessName: "B", tradespersonName: "Ant" });
    expect(system).toContain("Nothing is ever booked on these calls");
    expect(system).toContain("never write a day, time or date as settled");
  });

  // The eval run of 2026-11-08 lost two postcodes spelled out as "X Q, one three, one N P".
  it("keeps a spelled-out postcode, and one in an area the model doesn't recognise", () => {
    const { system } = buildExtractionPrompt([], { businessName: "B", tradespersonName: "Ant" });
    expect(system).toContain("spelled out letter by letter");
    expect(system).toContain("Write it even if you don't recognise the area");
  });

  // Phil's live call of 2026-11-10: the transcript had "Alice fifteen seven q y" for his
  // postcode and "Oh, four" for his name, and the summary said nothing about either.
  it("has a mangled name or postcode named in the summary, never guessed into the field", () => {
    const { system } = buildExtractionPrompt([], { businessName: "B", tradespersonName: "Ant" });
    expect(system).toContain("Speech recognition mangles names and postcodes");
    expect(system).toContain("leave that field null, never a guess, and say so in jobSummary");
    expect(system).toContain("Postcode not caught: sounded like");
    expect(system).toContain("still not in the field");
  });

  it("calls a silent call 'other', so the judge and the extraction agree", () => {
    expect(URGENCY_RULES).toContain(
      '"other" if the call wasn\'t about a job at all, or the caller said nothing',
    );
  });
});

describe("buildExtractionPrompt with the caller ID", () => {
  it('tells the model what "this number" means, and says nothing when the number was withheld', () => {
    const transcript = [{ role: "caller" as const, text: "Yes, this number's fine." }];
    const context = { businessName: "Ant's Plumbing", tradespersonName: "Ant" };
    expect(
      buildExtractionPrompt(transcript, { ...context, callerNumber: "+447700900123" }).system,
    ).toContain("callbackNumber is +447700900123");
    expect(buildExtractionPrompt(transcript, context).system).not.toContain("rang from");
  });
});
