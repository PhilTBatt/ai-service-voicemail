// The shared package's front door: every module in it is exported from index.ts (a module left
// out compiles in the package but can't be imported by the API or the dashboard), and its
// lists of names are each a clean set. Their match with the database's own checks is tested
// against Postgres in apps/api/src/db/shared-constants.test.ts.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as shared from "./index.ts";

const dir = fileURLToPath(new URL(".", import.meta.url));

describe("index.ts", () => {
  it("exports every module in the package", () => {
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const modules = readdirSync(dir).filter(
      (file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && file !== "index.ts",
    );
    expect(modules.length).toBeGreaterThan(5);
    for (const file of modules) expect(index, file).toContain(`export * from "./${file}";`);
  });

  it("exports the lists the API and the dashboard both use", () => {
    expect(shared.TRADES).toBeDefined();
    expect(shared.TENANT_STATUSES).toBeDefined();
    expect(shared.URGENCIES).toBeDefined();
    expect(shared.ONBOARDING_STATES).toBeDefined();
  });
});

describe("the lists of names", () => {
  it.each([
    ["TRADES", shared.TRADES],
    ["TENANT_STATUSES", shared.TENANT_STATUSES],
    ["URGENCIES", shared.URGENCIES],
    ["ONBOARDING_STATES", shared.ONBOARDING_STATES],
    ["LEGAL_DOCUMENT_TYPES", shared.LEGAL_DOCUMENT_TYPES],
  ] as const)("%s: each name once, in lower case with underscores", (_name, list) => {
    expect(list.length).toBeGreaterThan(0);
    expect(new Set(list).size).toBe(list.length);
    for (const value of list) expect(value).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });

  it("names every trade CallMate has templates for (BUILD_PLAN Step 3)", () => {
    expect([...shared.TRADES].sort()).toEqual([
      "electrician",
      "general_builder",
      "heating_engineer",
      "locksmith",
      "plumber",
      "roofer",
    ]);
  });

  it("has a label for every onboarding state", () => {
    for (const state of shared.ONBOARDING_STATES) {
      expect(shared.ONBOARDING_LABELS[state], state).toMatch(/\S/);
    }
    expect(Object.keys(shared.ONBOARDING_LABELS).sort()).toEqual(
      [...shared.ONBOARDING_STATES].sort(),
    );
  });
});
