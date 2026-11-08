// Saves a profile for the seeded demo tenant and queues its sync, then waits to say whether the
// worker synced it to Retell. The worker does the sync, so it has to be running too (npm run
// worker, in another terminal). Run from the repo root: npm run demo:profile [-- --wait 60]
// Fictional data only (CLAUDE.md).
import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { saveAgentProfile, waitForSync } from "../db/agent-profiles.ts";
import { createPool } from "../db/pool.ts";
import { SEED_TENANTS } from "../db/seed.ts";
import { lastHeartbeat, workerState } from "../db/worker-heartbeat.ts";
import { startQueue } from "../jobs/queue.ts";

/** "13:06:20", UK time. */
const ukTime = (at: Date) =>
  at.toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour12: false });

const { values } = parseArgs({
  options: {
    /** Seconds to wait for the sync; 0 saves and stops. */
    wait: { type: "string", default: "60" },
  },
});
const waitSeconds = Number(values.wait);
if (!Number.isInteger(waitSeconds) || waitSeconds < 0) {
  console.error("--wait must be a whole number of seconds");
  process.exit(2);
}

const config = loadConfig(process.env);
const pool = createPool(config.databaseUrl);
const boss = await startQueue(config.databaseUrl);
const tenantId = SEED_TENANTS[0]!.id;
try {
  const version = await saveAgentProfile(pool, boss, tenantId, {
    trade: "plumber",
    services: ["boiler repairs and servicing", "burst pipes and leaks", "bathroom fitting"],
    serviceAreas: ["Leeds", "Bradford", "Wakefield"],
    openingHours: {
      mon: { open: "08:00", close: "18:00" },
      tue: { open: "08:00", close: "18:00" },
      wed: { open: "08:00", close: "18:00" },
      thu: { open: "08:00", close: "18:00" },
      fri: { open: "08:00", close: "17:00" },
      sat: { open: "09:00", close: "13:00" },
      sun: null,
    },
    holidayMode: false,
    holidayUntil: null,
    faqs: [
      {
        question: "Do you fit bathrooms?",
        answer:
          "Yes, full bathroom fitting is one of the services. Ant will talk it through when he calls back.",
      },
    ],
    emergencyPolicy: { takesEmergencyCalls: true },
  });

  if (waitSeconds === 0) {
    console.log(`Saved the demo profile as version ${version}; its sync is queued for the worker.`);
  } else {
    console.log(
      `Saved the demo profile as version ${version}. Waiting up to ${waitSeconds} s for the worker to sync it to Retell...`,
    );
    const outcome = await waitForSync(pool, tenantId, version, { timeoutMs: waitSeconds * 1000 });
    if (outcome.state === "synced") {
      console.log(`Synced: the demo agent now uses version ${version}.`);
    } else if (outcome.state === "failed") {
      console.log(
        `Not synced: the last attempt failed with "${outcome.error}". The worker retries it; its log says more.`,
      );
      process.exitCode = 1;
    } else {
      // The worker checks in every 30 seconds (db/worker-heartbeat.ts), so this can say which.
      const worker = workerState(await lastHeartbeat(pool), new Date());
      const why =
        worker.state === "running"
          ? `The worker is running (it checked in at ${ukTime(worker.seenAt)}) but hasn't synced it: its log says why.`
          : `${worker.state === "never" ? "No worker has ever checked in" : `The worker hasn't checked in since ${ukTime(worker.seenAt)}`}, so it isn't running. Start it in another terminal with: npm run worker\nThe sync stays queued, so it runs once the worker starts.`;
      console.log(`Not synced after ${waitSeconds} s. ${why}`);
    }
  }
} finally {
  await boss.stop({ graceful: true, close: true });
  await pool.end();
}
