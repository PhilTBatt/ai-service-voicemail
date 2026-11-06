import { randomUUID } from "node:crypto";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TEST_DATABASE_URL } from "../testing/databases.ts";
import { startDeadLetterWatcher } from "./dead-letter.ts";
import { DEAD_LETTER_QUEUE, startQueue } from "./queue.ts";

let boss: PgBoss;

beforeAll(async () => {
  boss = await startQueue(TEST_DATABASE_URL);
});

afterAll(async () => {
  await boss.stop({ graceful: false, close: true });
});

describe("dead-letter watcher", () => {
  it("raises an alert for a job that failed every retry", { timeout: 40_000 }, async () => {
    const alert = vi.fn();
    await startDeadLetterWatcher(boss, alert);

    // A throwaway queue with no retries, dead-lettering into the shared queue.
    const queue = `doomed-${randomUUID().slice(0, 8)}`;
    await boss.createQueue(queue, { retryLimit: 0, deadLetter: DEAD_LETTER_QUEUE });
    await boss.work(queue, { pollingIntervalSeconds: 0.5 }, () =>
      Promise.reject(new Error("always fails")),
    );
    const marker = randomUUID();
    await boss.send(queue, { marker });

    const deadline = Date.now() + 30_000;
    // Older dead-lettered jobs from previous runs may be drained first: wait for this one.
    const ours = () =>
      alert.mock.calls.some(
        ([, details]) => (details as { data?: { marker?: string } }).data?.marker === marker,
      );
    while (!ours() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(alert).toHaveBeenCalledWith(
      "job-dead-lettered",
      expect.objectContaining({ data: expect.objectContaining({ marker }) as unknown }),
    );
    await boss.offWork(queue);
    await boss.offWork(DEAD_LETTER_QUEUE);
  });
});
