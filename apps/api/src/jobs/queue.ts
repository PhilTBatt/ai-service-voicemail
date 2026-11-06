import { PgBoss } from "pg-boss";
import { logger } from "../logger.ts";

export const SYNC_AGENT_QUEUE = "sync-agent";
/** Scheduled: picks up fallback voicemails whose callback never arrived. */
export const RECONCILE_VOICEMAILS_QUEUE = "reconcile-voicemails";
export const RECONCILE_VOICEMAILS_CRON = "*/15 * * * *";
/** Jobs that failed every retry land here, and anything in here raises an alert (Step 5). */
export const DEAD_LETTER_QUEUE = "dead-letter";

/**
 * Starts pg-boss as the app role. Its schema was installed by a migration (decision 008),
 * so pg-boss never creates or migrates anything itself: if a pg-boss upgrade needs a
 * schema change, start() fails fast instead of altering the database at runtime.
 */
export async function startQueue(connectionString: string): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString,
    schema: "pgboss",
    migrate: false,
    createSchema: false,
  });
  boss.on("error", (error: Error) => logger.error("Job queue error", { error }));
  await boss.start();

  await ensureQueue(boss, DEAD_LETTER_QUEUE, {});
  await ensureQueue(boss, SYNC_AGENT_QUEUE, {
    // One job per singletonKey (tenant + profile version) queued or active at a time.
    policy: "exclusive",
    retryLimit: 5,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 120,
    deadLetter: DEAD_LETTER_QUEUE,
  });
  await ensureQueue(boss, RECONCILE_VOICEMAILS_QUEUE, {
    policy: "singleton", // never two reconciliations at once
    retryLimit: 2,
    retryDelay: 60,
    expireInSeconds: 300,
    deadLetter: DEAD_LETTER_QUEUE,
  });
  return boss;
}

async function ensureQueue(
  boss: PgBoss,
  name: string,
  options: Parameters<PgBoss["createQueue"]>[1],
) {
  if (!(await boss.getQueue(name))) await boss.createQueue(name, options);
}
