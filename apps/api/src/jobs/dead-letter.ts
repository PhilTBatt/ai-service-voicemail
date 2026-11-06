// Anything that lands in the dead-letter queue has failed every retry. A person needs to
// see it (BUILD_PLAN Step 5), so each one raises an alert and is then marked complete:
// pg-boss keeps the job record for its retention window, so nothing is lost.
import type { PgBoss } from "pg-boss";
import { raiseAlert, type AlertFn } from "../alerts.ts";
import { DEAD_LETTER_QUEUE } from "./queue.ts";

export async function startDeadLetterWatcher(boss: PgBoss, alert: AlertFn = raiseAlert) {
  // Alerts are cheap, so take a batch at a time rather than one job per poll.
  await boss.work<Record<string, unknown>>(DEAD_LETTER_QUEUE, { batchSize: 20 }, async (jobs) => {
    for (const job of jobs) alert("job-dead-lettered", { deadLetterJobId: job.id, data: job.data });
    return Promise.resolve();
  });
}
