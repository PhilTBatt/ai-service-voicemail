// npm run load (BUILD_PLAN Step 14): starts the load-test API against the test database
// (testing/load-server.ts) and its worker (testing/load-worker.ts), runs the k6 script
// (apps/api/load/k6-load-test.js) from k6's Docker image against the API, waits for the worker
// to finish the calls' jobs, then checks every call's text went within 60 seconds of the call
// ending (BUILD_PLAN Step 6), and stops both. Fails if a k6 threshold broke or a text was late
// or never went, so a broken run fails the CI job too.
//
// Needs Docker running and the test database up (npm run db:up). The load-test API empties the
// test database first, as npm test and npm run e2e do, so don't run them at the same time.
// LOAD_CUSTOMERS, LOAD_MULTIPLIER, LOAD_CALL_MINUTES and LOAD_DURATION pass through to all three;
// LOAD_LLM_MS sets the fake model's time, LOAD_TEXT_SECONDS the deadline.
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createAdminPool, type AdminPool } from "../db/cross-tenant.ts";
import { TEST_ADMIN_DATABASE_URL } from "../testing/databases.ts";
import {
  LOAD_API_PORT,
  LOAD_PUBLIC_BASE_URL,
  LOAD_TEXT_DEADLINE_SECONDS,
} from "../testing/load-config.ts";

/** Pinned: k6's latest stable release when this was written (v2.3.0, 2026-11-07). */
const K6_IMAGE = "grafana/k6:2.3.0";
const SETTINGS = ["LOAD_CUSTOMERS", "LOAD_MULTIPLIER", "LOAD_CALL_MINUTES", "LOAD_DURATION"];
/** How long the worker gets, after k6 stops, to finish the last calls' jobs. */
const DRAIN_MS = 3 * 60_000;

const script = readFileSync(new URL("../../load/k6-load-test.js", import.meta.url));

function start(file: string): ChildProcess {
  return spawn(process.execPath, [fileURLToPath(new URL(file, import.meta.url))], {
    env: { ...process.env, LOG_LEVEL: "warn" },
    stdio: ["ignore", "inherit", "inherit"],
  });
}

const server = start("../testing/load-server.ts");
let worker: ChildProcess | undefined;

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
    await sleep(500);
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

/** The calls the run made (not the seeded history), each with when its text went, if it did. */
async function callTexts(
  admin: AdminPool,
  since: Date,
): Promise<{ calls: number; seconds: number[] }> {
  const { rows } = await admin.query<{ seconds: number | null }>(
    // The text's row is 'sent' when Twilio (here, the fake) took it, and updated_at says when.
    // Delivery receipts would move it on, but the k6 script's receipts name made-up messages.
    `SELECT extract(epoch FROM n.updated_at - c.created_at)::float8 AS seconds
     FROM calls c
     LEFT JOIN notifications n
       ON n.call_id = c.id AND n.channel = 'sms' AND n.status IN ('sent', 'delivered', 'undelivered')
     WHERE c.created_at >= $1 AND NOT c.via_fallback`,
    [since],
  );
  return {
    calls: rows.length,
    seconds: rows.flatMap((row) => (row.seconds === null ? [] : [row.seconds])),
  };
}

/** The value below which `share` of the sorted list falls (nearest rank). */
function percentile(sorted: number[], share: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)] ?? 0;
}

/**
 * Waits for the worker to text every call the run made (or for DRAIN_MS), then says how long
 * each took and whether any was late or never went. True when every text was in time.
 */
async function checkTexts(admin: AdminPool, since: Date): Promise<boolean> {
  const deadline = Date.now() + DRAIN_MS;
  let result = await callTexts(admin, since);
  while (result.seconds.length < result.calls && Date.now() < deadline) {
    await sleep(2_000);
    result = await callTexts(admin, since);
  }
  const sorted = [...result.seconds].sort((a, b) => a - b);
  const late = sorted.filter((seconds) => seconds > LOAD_TEXT_DEADLINE_SECONDS).length;
  const missing = result.calls - sorted.length;
  const fmt = (seconds: number) => `${seconds.toFixed(1)} s`;
  console.log(
    [
      "",
      "Call ended to text sent (the worker, with the fakes' delays):",
      `  calls ${result.calls}, texted ${sorted.length}, never texted ${missing}`,
      `  median ${fmt(percentile(sorted, 0.5))}, p95 ${fmt(percentile(sorted, 0.95))}, max ${fmt(sorted.at(-1) ?? 0)}`,
      `  over ${LOAD_TEXT_DEADLINE_SECONDS} s: ${late}`,
    ].join("\n"),
  );
  const ok = result.calls > 0 && late === 0 && missing === 0;
  if (!ok) {
    console.error(
      result.calls === 0
        ? "No calls reached the database: the run didn't test the worker."
        : `Texts were late or never went: ${late} over ${LOAD_TEXT_DEADLINE_SECONDS} s, ${missing} missing.`,
    );
  }
  return ok;
}

/**
 * The database's own time, which stamps the calls: this machine's clock can be minutes away
 * from it (Docker Desktop's drifted after a laptop slept, 2026-11-13), and the seeded history
 * then counted as the run's calls.
 */
async function databaseNow(admin: AdminPool): Promise<Date> {
  return (await admin.query<{ now: Date }>("SELECT now() AS now")).rows[0]!.now;
}

// One pool for the runner's own reads, opened once (repo-invariants.test.ts counts each script's).
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);
let exitCode = 1;
try {
  await waitForApi();
  worker = start("../testing/load-worker.ts");
  const since = await databaseNow(admin);
  const k6Code = await runK6();
  const textsOk = await checkTexts(admin, since);
  exitCode = k6Code !== 0 ? k6Code : textsOk ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
} finally {
  worker?.kill();
  server.kill();
  await admin.end();
}
process.exit(exitCode);
