import { describe, expect, it } from "vitest";
import { TENANT_STATUSES } from "./index.ts";

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
