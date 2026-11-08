import { describe, expect, it } from "vitest";
import {
  LEGAL_DOCUMENTS,
  LEGAL_DOCUMENT_TYPES,
  TENANT_STATUSES,
  URGENCIES,
  acceptDocumentsSchema,
  documentsToAccept,
} from "./index.ts";

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

describe("documentsToAccept", () => {
  const current = Object.fromEntries(
    LEGAL_DOCUMENT_TYPES.map((type) => [type, LEGAL_DOCUMENTS[type].version]),
  );

  it("asks for every document a business never accepted, and none it accepted as they stand", () => {
    expect(documentsToAccept({})).toEqual([...LEGAL_DOCUMENT_TYPES]);
    expect(documentsToAccept(current)).toEqual([]);
  });

  it("asks again for a document whose version changed since it was accepted", () => {
    expect(documentsToAccept({ ...current, dpa: "an-older-version" })).toEqual(["dpa"]);
  });
});

describe("acceptDocumentsSchema", () => {
  it("takes a version for any of the documents, and no others", () => {
    // The schema lists the documents by name: this keeps it in step with LEGAL_DOCUMENT_TYPES.
    const all = Object.fromEntries(LEGAL_DOCUMENT_TYPES.map((type) => [type, "v1"]));
    expect(acceptDocumentsSchema.safeParse({ versions: all }).success).toBe(true);
    expect(acceptDocumentsSchema.safeParse({ versions: { terms: "v1" } }).success).toBe(true);
    expect(acceptDocumentsSchema.safeParse({ versions: {} }).success).toBe(false);
    expect(acceptDocumentsSchema.safeParse({ versions: { cookies: "v1" } }).success).toBe(false);
  });
});
