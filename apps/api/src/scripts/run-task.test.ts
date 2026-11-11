// The production task runner (the callmate-task job), run as the job runs it: one encoded
// argument. It must run only a script from its own folder, pass the arguments through intact
// (the "--" ones Azure's CLI would otherwise eat), and end with the script's own exit code.
// The script it runs here, print-fallback-twiml, only prints: it touches no service.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { encodeTaskCommand } from "../core/task-command.ts";

const run = promisify(execFile);
const runner = fileURLToPath(new URL("./run-task.ts", import.meta.url));

async function task(args: string[], settings: Record<string, string> = {}) {
  // print-fallback-twiml reads the config, which needs a database URL; it never connects.
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    DATABASE_URL: "postgres://app@localhost/callmate",
    ...settings,
  };
  for (const name of ["PATH", "Path", "SystemRoot", "TEMP", "TMP"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  try {
    const { stdout, stderr } = await run(process.execPath, [runner, ...args], { env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

describe("run-task", () => {
  it("stops with code 2 when started with no command (the job's own default)", async () => {
    const result = await task([]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("needs the encoded command");
  }, 30_000);

  it("runs the named script and ends with its exit code, 0", async () => {
    const result = await task([encodeTaskCommand("print-fallback-twiml")]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Running print-fallback-twiml");
    expect(result.stdout).toContain("<Response>");
  }, 30_000);

  it("passes -- arguments through, and ends with the script's failing code", async () => {
    // With --done-url and no PUBLIC_BASE_URL, the script says what's missing and exits 1.
    const result = await task([
      encodeTaskCommand("print-fallback-twiml --done-url https://handler.twilio.com/twiml/EH0"),
    ]);
    expect(result.stdout).toContain(
      "Running print-fallback-twiml --done-url https://handler.twilio.com/twiml/EH0",
    );
    expect(result.stderr).toContain("PUBLIC_BASE_URL is missing");
    expect(result.code).toBe(1);
  }, 30_000);

  it("stops with code 2 for a script that doesn't exist", async () => {
    const result = await task([encodeTaskCommand("no-such-script --email x@example.com")]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("No such script: no-such-script");
  }, 30_000);

  // A path would reach scripts outside the folder (the seed, say, or a test helper).
  it.each(["../db/seed", "..", "scripts/invite-user", "C:\\Windows\\system32\\cmd", "Invite-User"])(
    "refuses %s as a script name, running nothing",
    async (name) => {
      const result = await task([encodeTaskCommand(`${name} --x`)]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("isn't a script name");
      expect(result.stdout).not.toContain("Running");
    },
    30_000,
  );

  it("refuses an empty command", async () => {
    const result = await task([encodeTaskCommand("   ")]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("No script named");
  }, 30_000);
});
