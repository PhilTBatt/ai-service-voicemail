// npm run load (BUILD_PLAN Step 14): starts the load-test API against the test database
// (testing/load-server.ts), runs the k6 script (apps/api/load/k6-load-test.js) from k6's Docker
// image against it, then stops the API. Exits with k6's code, so a broken threshold fails the
// run, and the CI job.
//
// Needs Docker running and the test database up (npm run db:up). The load-test API empties the
// test database first, as npm test and npm run e2e do, so don't run them at the same time.
// LOAD_CUSTOMERS, LOAD_MULTIPLIER, LOAD_CALL_MINUTES and LOAD_DURATION pass through to both.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LOAD_API_PORT, LOAD_PUBLIC_BASE_URL } from "../testing/load-config.ts";

/** Pinned: k6's latest stable release when this was written (v2.3.0, 2026-11-07). */
const K6_IMAGE = "grafana/k6:2.3.0";
const SETTINGS = ["LOAD_CUSTOMERS", "LOAD_MULTIPLIER", "LOAD_CALL_MINUTES", "LOAD_DURATION"];

const script = readFileSync(new URL("../../load/k6-load-test.js", import.meta.url));
const server = spawn(
  process.execPath,
  [fileURLToPath(new URL("../testing/load-server.ts", import.meta.url))],
  { env: { ...process.env, LOG_LEVEL: "warn" }, stdio: ["ignore", "inherit", "inherit"] },
);

/** Waits for the API to answer: seeding the businesses takes a few seconds first. */
async function waitForApi(): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`The load-test API stopped with code ${server.exitCode}`);
    }
    try {
      if ((await fetch(`http://127.0.0.1:${LOAD_API_PORT}/readyz`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("The load-test API didn't start within 2 minutes");
}

function runK6(): Promise<number> {
  const k6 = spawn(
    "docker",
    [
      "run",
      "--rm",
      "-i",
      // How the container reaches this machine. Docker Desktop knows the name already; on
      // Linux (CI) it has to be added.
      "--add-host=host.docker.internal:host-gateway",
      "-e",
      `API_URL=http://host.docker.internal:${LOAD_API_PORT}`,
      "-e",
      `PUBLIC_BASE_URL=${LOAD_PUBLIC_BASE_URL}`,
      ...SETTINGS.flatMap((name) => {
        const value = process.env[name];
        return value ? ["-e", `${name}=${value}`] : [];
      }),
      K6_IMAGE,
      "run",
      "--quiet", // no progress bar: just the report at the end
      "-", // the script comes in on stdin
    ],
    { stdio: ["pipe", "inherit", "inherit"] },
  );
  k6.stdin.end(script);
  return new Promise((resolve, reject) => {
    k6.on("error", (error) => {
      reject(new Error(`Couldn't run Docker (is Docker Desktop running?): ${error.message}`));
    });
    k6.on("close", (code) => {
      resolve(code ?? 1);
    });
  });
}

let exitCode = 1;
try {
  await waitForApi();
  exitCode = await runK6();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
} finally {
  server.kill();
}
process.exit(exitCode);
