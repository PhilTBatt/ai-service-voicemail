import { describe, expect, it } from "vitest";
import {
  EXTRACTION_FAILED_FLAG,
  JUDGE_FAILED_FLAG,
  REVIEW_FLAGS,
  guardrailFlag,
} from "./review.ts";

describe("REVIEW_FLAGS", () => {
  it("covers every guardrail rule, the judge and a failed summary", () => {
    expect([...REVIEW_FLAGS].sort()).toEqual(
      [
        guardrailFlag("price"),
        guardrailFlag("commitment"),
        guardrailFlag("safety"),
        JUDGE_FAILED_FLAG,
        EXTRACTION_FAILED_FLAG,
      ].sort(),
    );
    expect(guardrailFlag("safety")).toBe("guardrail:safety");
  });

  it("leaves out the extraction's notes and the mid-call emergency marks", () => {
    for (const note of ["mentioned gas smell", "caller abusive", "emergency:gas"]) {
      expect(REVIEW_FLAGS).not.toContain(note);
    }
  });
});
