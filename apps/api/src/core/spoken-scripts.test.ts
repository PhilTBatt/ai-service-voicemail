import { describe, expect, it } from "vitest";
import { COMMITMENT_PATTERNS, PRICE_PATTERNS } from "@callmate/shared";
import {
  DANGER_SCRIPT,
  areYouAiLine,
  closingLine,
  gasScript,
  openingLine,
  waterScript,
} from "./scripts.ts";
import {
  DANGER_SCRIPT_KEY,
  dangerScriptSpoken,
  emergencyScriptSpoken,
  gasScriptSpoken,
} from "./spoken-scripts.ts";

const NAMES = { business: "Wren Plumbing", tradesperson: "Ant" };

describe("emergencyScriptSpoken", () => {
  it("finds the danger script, by words only it says", () => {
    expect(DANGER_SCRIPT.toLowerCase()).toContain(DANGER_SCRIPT_KEY);
    const transcript = `caller: There's a burning smell from the fuse box.\nagent: ${DANGER_SCRIPT}`;
    expect(dangerScriptSpoken(transcript)).toBe(true);
    expect(emergencyScriptSpoken(transcript)).toBe(true);
  });

  it("finds the gas script in either region", () => {
    for (const region of ["GB", "NI"] as const) {
      expect(gasScriptSpoken(`agent: ${gasScript("Ant", region)}`), region).toBe(true);
    }
  });

  it("ignores the caller saying the words, and a call with no transcript", () => {
    expect(emergencyScriptSpoken("caller: Should I hang up now and call 999?")).toBe(false);
    expect(emergencyScriptSpoken(null)).toBe(false);
  });
});

describe("Appendix A's scripts against the price and time patterns", () => {
  it("never trip the post-call scan", () => {
    const scripts = [
      openingLine(NAMES),
      gasScript("Ant", "GB"),
      gasScript("Ant", "NI"),
      DANGER_SCRIPT,
      waterScript("Ant"),
      areYouAiLine(NAMES),
      closingLine("Ant"),
    ];
    for (const script of scripts) {
      for (const sentence of script.split(/(?<=[.?!])\s+/)) {
        expect(
          PRICE_PATTERNS.some((p) => p.test(sentence)),
          sentence,
        ).toBe(false);
        expect(
          COMMITMENT_PATTERNS.some((p) => p.test(sentence)),
          sentence,
        ).toBe(false);
      }
    }
  });
});
