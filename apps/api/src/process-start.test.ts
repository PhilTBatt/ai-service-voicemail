// server.ts and worker.ts, run as Azure runs them: `node <file>` with an environment and
// nothing else. Their wiring is tested in server-app.test.ts and worker-jobs.test.ts; this is
// the start-up around it: a bad environment stops the process with exit code 1 and names the
// settings (never their values), a good one answers its health checks, and a port already in
// use stops the API rather than leaving it half started.
//
// The worker is only ever started with a bad environment here: started for real, it would take
// jobs queued by other test files and check in as the one worker (db/worker-heartbeat.test.ts
// owns that row).
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TEST_DATABASE_URL } from "./testing/databases.ts";

const SERVER = fileURLToPath(new URL("./server.ts", import.meta.url));
const WORKER = fileURLToPath(new URL("./worker.ts", import.meta.url));

/**
 * Only what Node needs to run on this machine, then the settings given: nothing else from the
 * test run's environment, so no setting on this machine can switch a provider on.
 */
function cleanEnv(settings: Record<string, string>): NodeJS.ProcessEnv {
  const keep = ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE"];
  return {
    ...Object.fromEntries(
      keep.flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])),
    ),
    ...settings,
  };
}

interface Started {
  child: ChildProcess;
  output: () => string;
  exited: Promise<number | null>;
}

function start(file: string, settings: Record<string, string>): Started {
  const child = spawn(process.execPath, [file], {
    env: cleanEnv(settings),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
  const exited = once(child, "exit").then(([code]) => code as number | null);
  return { child, output: () => output, exited };
}

/** The process's JSON log lines, parsed; anything else on stdout is skipped. */
function logLines(output: string): { level: string; message: string; [key: string]: unknown }[] {
  return output.split("\n").flatMap((line) => {
    try {
      const parsed = JSON.parse(line) as unknown;
      return typeof parsed === "object" && parsed !== null && "message" in parsed
        ? [parsed as { level: string; message: string }]
        : [];
    } catch {
      return [];
    }
  });
}

async function freePort(): Promise<number> {
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function waitFor(check: () => Promise<boolean>, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

// A recognisable marker, not a realistic secret: GitGuardian watches this repo.
const MARKER = "zzmarker";

describe("server.ts", () => {
  it("stops with exit code 1 on a bad environment, naming each setting but no value", async () => {
    const run = start(SERVER, {
      NODE_ENV: "test",
      PORT: MARKER,
      SIGNING_SECRET: `${MARKER}-too-short`,
    });
    expect(await run.exited).toBe(1);
    const lines = logLines(run.output());
    const failure = lines.find((line) => line.message === "Invalid environment configuration");
    expect(failure?.level).toBe("error");
    expect(failure?.["problems"]).toEqual(
      expect.arrayContaining([
        "DATABASE_URL is missing",
        expect.stringMatching(/^PORT is invalid/) as unknown,
        expect.stringMatching(/^SIGNING_SECRET is invalid/) as unknown,
      ]),
    );
    expect(run.output()).not.toContain(MARKER);
    // It stopped before connecting to anything or listening.
    expect(lines.map((line) => line.message)).not.toContain("API listening");
  }, 30_000);

  it("refuses production without its required settings, before connecting to anything", async () => {
    const run = start(SERVER, { NODE_ENV: "production", DATABASE_URL: TEST_DATABASE_URL });
    expect(await run.exited).toBe(1);
    const failure = logLines(run.output()).find(
      (line) => line.message === "Invalid environment configuration",
    );
    expect(failure?.["problems"]).toEqual(
      expect.arrayContaining(["RETELL_API_KEY is missing", "SIGNING_SECRET is missing"]),
    );
  }, 30_000);

  it("starts with only the database, answers its health checks, and says what's off", async () => {
    const port = await freePort();
    const run = start(SERVER, {
      NODE_ENV: "test",
      DATABASE_URL: TEST_DATABASE_URL,
      PORT: String(port),
    });
    try {
      await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/healthz`)).ok, "/healthz");
      const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(ready.status).toBe(200);

      const messages = logLines(run.output()).map((line) => line.message);
      expect(messages).toContain("API listening");
      // Each switched-off feature says so at start-up, which is how Phil finds a missing setting.
      expect(messages).toEqual(
        expect.arrayContaining([
          "RETELL_API_KEY not set: voice webhooks are disabled",
          "Call pages disabled: SIGNING_SECRET isn't set",
          "Billing disabled: GOCARDLESS_ACCESS_TOKEN isn't set",
          "Dashboard API disabled: needs CLERK_SECRET_KEY and ADMIN_DATABASE_URL",
          "Alert emails off: needs ALERT_EMAIL, POSTMARK_SERVER_TOKEN and EMAIL_FROM",
        ]),
      );
    } finally {
      run.child.kill();
      await run.exited;
    }
  }, 60_000);

  // Without this, an API that couldn't take its port would sit with the queue and pools open
  // and never serve a request: the health probe would restart it, but only after a wait.
  it("stops with exit code 1, its queue and pools closed, when the port is taken", async () => {
    // On every address, as the API listens: one held on 127.0.0.1 alone doesn't stop the API
    // taking the same port on the others.
    const taken = createServer().listen(0);
    await once(taken, "listening");
    const { port } = taken.address() as AddressInfo;
    try {
      const run = start(SERVER, {
        NODE_ENV: "test",
        DATABASE_URL: TEST_DATABASE_URL,
        PORT: String(port),
      });
      const code = await Promise.race([
        run.exited,
        new Promise<"still running">((resolve) =>
          setTimeout(() => resolve("still running"), 40_000),
        ),
      ]);
      if (code === "still running") run.child.kill();
      expect(code, run.output()).toBe(1);
      const failure = logLines(run.output()).find((line) => line.message === "API failed to start");
      expect(failure?.level).toBe("error");
      expect(failure?.["port"]).toBe(port);
    } finally {
      await new Promise((resolve) => taken.close(resolve));
    }
  }, 60_000);
});

describe("worker.ts", () => {
  it("stops with exit code 1 without Retell, which it needs to sync agents", async () => {
    const run = start(WORKER, { NODE_ENV: "test", DATABASE_URL: TEST_DATABASE_URL });
    expect(await run.exited).toBe(1);
    const failure = logLines(run.output()).find(
      (line) => line.message === "Invalid environment configuration",
    );
    expect(failure?.level).toBe("error");
    expect(failure?.["problems"]).toEqual([
      "RETELL_API_KEY is missing (the worker syncs agents to Retell)",
    ]);
    expect(logLines(run.output()).map((line) => line.message)).not.toContain("Worker listening");
  }, 30_000);

  it("stops with exit code 1 on a bad environment, naming each setting but no value", async () => {
    const run = start(WORKER, {
      NODE_ENV: "test",
      DATABASE_URL: `mysql://app:${MARKER}@localhost/callmate`,
      RETELL_API_KEY: "key_for_tests",
      GOCARDLESS_ENVIRONMENT: MARKER,
    });
    expect(await run.exited).toBe(1);
    const failure = logLines(run.output()).find(
      (line) => line.message === "Invalid environment configuration",
    );
    expect(failure?.["problems"]).toEqual([
      expect.stringMatching(/^DATABASE_URL is invalid/) as unknown,
      expect.stringMatching(/^GOCARDLESS_ENVIRONMENT is invalid/) as unknown,
    ]);
    expect(run.output()).not.toContain(MARKER);
  }, 30_000);
});
