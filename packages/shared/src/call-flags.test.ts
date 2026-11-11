import { describe, expect, it } from "vitest";
import { isInternalFlag, tradespersonFlags } from "./call-flags.ts";

describe("isInternalFlag", () => {
  it.each([
    "guardrail:price",
    "guardrail:commitment",
    "guardrail:safety",
    "guardrail:anything-added-later",
    "judge:failed",
    "extraction_failed",
  ])("keeps %j for the admin", (flag) => {
    expect(isInternalFlag(flag)).toBe(true);
  });

  it.each([
    "mentioned gas smell",
    "caller abusive",
    "existing customer chasing a job",
    "call cut off",
    // Looks like ours, but isn't one of the pipeline's: a note the summary wrote
    "guardrail",
    "judge",
    "extraction failed",
    "price guardrail:",
    "Guardrail:price",
    "",
  ])("shows %j to the tradesperson", (flag) => {
    expect(isInternalFlag(flag)).toBe(false);
  });
});

describe("tradespersonFlags", () => {
  it("keeps the summary's notes, in order, and drops the pipeline's own", () => {
    expect(
      tradespersonFlags([
        "mentioned gas smell",
        "guardrail:price",
        "judge:failed",
        "caller abusive",
        "extraction_failed",
      ]),
    ).toEqual(["mentioned gas smell", "caller abusive"]);
    expect(tradespersonFlags([])).toEqual([]);
  });

  it("puts a safety message played mid-call in words, and never shows a code", () => {
    expect(tradespersonFlags(["emergency:gas", "mentioned gas smell"])).toEqual([
      "Gas safety message given",
      "mentioned gas smell",
    ]);
    expect(tradespersonFlags(["emergency:danger"])).toEqual(["999 safety message given"]);
    // A kind with no words yet stays out rather than reaching the tradesperson as jargon.
    expect(tradespersonFlags(["emergency:flood", "caller abusive"])).toEqual(["caller abusive"]);
    // Prototype names aren't words for anything.
    expect(tradespersonFlags(["constructor", "__proto__"])).toEqual(["constructor", "__proto__"]);
  });
});
