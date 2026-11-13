// npm run twiml:fallback, run as Phil runs it: a separate Node process with its arguments.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MINIMAL_WORKER_ENV } from "../testing/stand-in-env.ts";

const SCRIPT = fileURLToPath(new URL("./print-fallback-twiml.ts", import.meta.url));
const BIN_1_ID = "EH" + "1".repeat(32);
const BASE_URL = "https://callmate.example.com";

function run(...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { ...MINIMAL_WORKER_ENV, PATH: process.env.PATH ?? "" },
    encoding: "utf8",
  });
}

describe("npm run twiml:fallback, bin 2", () => {
  it("refuses bin 1's ID on its own, asking for the whole URL", () => {
    const result = run("--done-url", BIN_1_ID, "--base-url", BASE_URL);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("bin 1's whole URL, starting https://");
    expect(result.stdout).toBe("");
  });

  it("prints bin 2 pointing at bin 1's whole URL", () => {
    const binUrl = `https://handler.twilio.com/twiml/${BIN_1_ID}`;
    const result = run("--done-url", binUrl, "--base-url", BASE_URL);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`action="${binUrl}"`);
    expect(result.stdout).toContain(
      `recordingStatusCallback="${BASE_URL}/webhooks/twilio/recording"`,
    );
  });
});
