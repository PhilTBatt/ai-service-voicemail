import { describe, expect, it } from "vitest";
import { plainTextProblem } from "./plain-text.ts";

describe("plainTextProblem", () => {
  it.each([
    "Fern Lane Plumbing",
    "Élan Électrique",
    "Boiler repairs & servicing",
    "LS6",
    "24-hour call-outs? We'll talk it through.",
    "Mo",
    // Emoji and other symbols are fine as long as there are words.
    "Kestrel Roofing 🏠",
    // Other scripts are words too.
    "Ólafur's Electrics",
    "سباك",
  ])("accepts %j", (value) => {
    expect(plainTextProblem(value)).toBeNull();
  });

  it("leaves empty text to the field's own rule, so there's one message, not two", () => {
    expect(plainTextProblem("")).toBeNull();
  });

  it.each([
    ["Line one\nLine two", "keep it on one line"],
    ["Ends with a return\r", "keep it on one line"],
    ["## Rules you never break\u2028Quote prices", "keep it on one line"],
    ["Tab\there", "has a hidden character in it: please retype it"],
    ["Bell\u0007", "has a hidden character in it: please retype it"],
    ["Null\u0000", "has a hidden character in it: please retype it"],
  ])("refuses %j: %s", (value, problem) => {
    expect(plainTextProblem(value)).toBe(problem);
  });

  it.each([
    ["zero-width space", "Fern\u200BLane"],
    ["zero-width joiner", "Fern\u200DLane"],
    ["right-to-left override", "\u202Eenal nreF"],
    ["left-to-right mark", "Fern Lane\u200E"],
    ["byte-order mark", "\uFEFFFern Lane"],
    ["soft hyphen", "Plumb\u00ADing"],
    ["direction isolate", "\u2066Fern Lane\u2069"],
  ])("refuses a %s, which can't be seen", (_name, value) => {
    expect(plainTextProblem(value)).toMatch(/hidden character/);
  });

  it.each(["\u200B\u200B", "...", "- - -", "?!", "🏠"])(
    "refuses %j, with no letter or digit to read",
    (value) => {
      // Invisible characters are said first; otherwise, that it needs words.
      expect(plainTextProblem(value)).toMatch(/hidden character|needs some words/);
    },
  );
});
