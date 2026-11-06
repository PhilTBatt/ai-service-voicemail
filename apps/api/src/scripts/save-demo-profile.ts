// Saves a profile for the seeded demo tenant and queues its sync, so a running worker
// creates the agent on Retell. Run from the repo root: npm run demo:profile
// Fictional data only (CLAUDE.md).
import { loadConfig } from "../config.ts";
import { saveAgentProfile } from "../db/agent-profiles.ts";
import { createPool } from "../db/pool.ts";
import { SEED_TENANTS } from "../db/seed.ts";
import { startQueue } from "../jobs/queue.ts";
import { logger } from "../logger.ts";

const config = loadConfig(process.env);
const pool = createPool(config.databaseUrl);
const boss = await startQueue(config.databaseUrl);
try {
  const version = await saveAgentProfile(pool, boss, SEED_TENANTS[0]!.id, {
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
  logger.info("Demo profile saved and sync queued", { tenantId: SEED_TENANTS[0]!.id, version });
} finally {
  await boss.stop({ graceful: true, close: true });
  await pool.end();
}
