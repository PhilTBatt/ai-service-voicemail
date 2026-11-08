// Keeps the alerts honest (BUILD_PLAN Step 15: "every alert has fired at least once in
// testing"). Every alert in ALERTS must be named in a test, which is where it's made to fire
// and checked, and must have its entry in RUNBOOK section 11 for whoever gets woken by it.
// The type on raiseAlert already stops code raising an alert that isn't in the list.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALERTS } from "./alerts.ts";

const sourceDir = fileURLToPath(new URL(".", import.meta.url));
const tests = readdirSync(sourceDir, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".test.ts") && file !== "alerts.test.ts")
  .map((file) => readFileSync(join(sourceDir, file), "utf8"))
  .join("\n");
const runbook = readFileSync(new URL("../../../docs/RUNBOOK.md", import.meta.url), "utf8");

describe("every alert", () => {
  for (const alert of ALERTS) {
    it(`${alert}: a test makes it fire, and the runbook explains it`, () => {
      expect(tests, "no test names it").toContain(`"${alert}"`);
      expect(runbook, "RUNBOOK section 11 doesn't list it").toContain(`\`${alert}\``);
    });
  }
});
