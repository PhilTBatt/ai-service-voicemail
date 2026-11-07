import { describe, expect, it } from "vitest";
import { TENANT_STATUSES, URGENCIES } from "./index.ts";

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
