import { describe, expect, it } from "vitest";
import { LEGAL_DOCUMENTS, TENANT_STATUSES, URGENCIES } from "./index.ts";

describe("TENANT_STATUSES", () => {
  it("matches the statuses in BUILD_PLAN Step 1", () => {
    expect(TENANT_STATUSES).toEqual([
      "onboarding",
      "live",
      "paused",
      "suspended",
      "cancelling",
      "cancelled",
      "demo",
    ]);
  });
});

describe("URGENCIES", () => {
  it("matches the calls.urgency CHECK constraint", () => {
    expect(URGENCIES).toEqual(["emergency", "urgent", "routine", "spam", "other"]);
  });
});

describe("LEGAL_DOCUMENTS", () => {
  it("never marks a placeholder version as approved", () => {
    // Approving the solicitor's text means a new version too: otherwise every business that
    // accepted the placeholder would count as having accepted the real document.
    for (const [type, document] of Object.entries(LEGAL_DOCUMENTS)) {
      if (document.approved) expect(document.version, type).not.toMatch(/placeholder/i);
    }
  });
});
