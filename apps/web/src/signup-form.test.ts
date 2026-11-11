import { LEGAL_DOCUMENT_TYPES, signupInputSchema } from "@callmate/shared";
import { describe, expect, it } from "vitest";
import { signupProblems } from "./signup-form.ts";

describe("signupProblems", () => {
  it("puts each problem by its field, in words, from the real schema", () => {
    const result = signupInputSchema.safeParse({
      code: "x",
      businessName: "",
      trade: "plumber",
      contactName: "Jo",
      mobile: "0770",
      email: null,
      mobileNetwork: "",
      usesNetworkVoicemail: false,
      accepted: Object.fromEntries(LEGAL_DOCUMENT_TYPES.map((type) => [type, ""])),
    });
    expect(result.success).toBe(false);
    const problems = signupProblems(result.success ? [] : result.error.issues, true);
    expect(problems.mobileNetwork).toEqual(["Choose your network"]);
    expect(problems.accepted).toEqual(["Documents: tick all three to continue"]);
    expect(problems.usesNetworkVoicemail).toEqual(["Choose yes or no"]);
    expect(problems.businessName?.length).toBe(1);
    expect(problems.mobile?.length).toBe(1);
    expect(problems.contactName).toBeUndefined();
    // The schema's list of allowed networks never reaches the page.
    expect(JSON.stringify(problems)).not.toMatch(/expected one of/i);
  });

  it("says each message once, starting with a capital", () => {
    const issue = { path: ["businessName"], message: "can't be empty" };
    expect(signupProblems([issue, issue], false)).toEqual({ businessName: ["Can't be empty"] });
  });
});
