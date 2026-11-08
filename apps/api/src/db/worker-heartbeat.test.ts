// Every test that writes the worker's check-in lives in this file: it's one row for the whole
// service, and test files run in parallel. Others only read it.
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { logger } from "../logger.ts";
import { TEST_DATABASE_URL } from "../testing/databases.ts";
import { createPool } from "./pool.ts";
import {
  WORKER_DOWN_AFTER_MS,
  lastHeartbeat,
  recordHeartbeat,
  startHeartbeat,
  workerState,
} from "./worker-heartbeat.ts";

// The app role, as the worker and the API connect.
const pool = createPool(TEST_DATABASE_URL);

afterAll(async () => {
  await pool.end();
});

describe("workerState", () => {
  const now = new Date("2026-11-08T13:00:00Z");
  const ago = (ms: number) => ({ seenAt: new Date(now.getTime() - ms) });

  it("is never with no check-in on record, running within two minutes, and down after", () => {
    expect(workerState(null, now)).toEqual({ state: "never" });
    expect(workerState(ago(30_000), now).state).toBe("running");
    expect(workerState(ago(WORKER_DOWN_AFTER_MS), now).state).toBe("running");
    expect(workerState(ago(WORKER_DOWN_AFTER_MS + 1), now)).toEqual({
      state: "down",
      seenAt: ago(WORKER_DOWN_AFTER_MS + 1).seenAt,
    });
  });
});

describe("startHeartbeat", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("checks in at once, then on every interval, until stopped", async () => {
    vi.useFakeTimers();
    const record = vi.fn(() => Promise.resolve());
    const heartbeat = startHeartbeat(record, 30_000);
    expect(record).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(record).toHaveBeenCalledTimes(4);
    heartbeat.stop();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(record).toHaveBeenCalledTimes(4);
  });

  it("logs a failed check-in and carries on, so the heartbeat never stops the worker", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    const record = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("database restarting"))
      .mockResolvedValue(undefined);
    const heartbeat = startHeartbeat(record, 30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    heartbeat.stop();
    expect(record).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith("Worker check-in failed", expect.any(Object));
    warn.mockRestore();
  });
});

describe("the check-in in the database, and GET /healthz/worker", () => {
  /** Starts the real app on a free port, and returns a GET for it. */
  async function startApp() {
    const server = createApp({ pool }).listen(0);
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    return {
      get: (path: string) => fetch(`http://127.0.0.1:${port}${path}`),
      stop: () => new Promise((resolve) => server.close(resolve)),
    };
  }

  // In order: the setup empties the table, so the run starts with no worker on record.
  it("answers 503 never, then 200 running once the worker checks in, then 503 down", async () => {
    const app = await startApp();
    try {
      expect(await lastHeartbeat(pool)).toBeNull();
      const never = await app.get("/healthz/worker");
      expect(never.status).toBe(503);
      expect(await never.json()).toEqual({ status: "never", lastSeen: null });

      const startedAt = new Date("2026-11-08T12:00:00Z");
      await recordHeartbeat(pool, startedAt);
      const beat = await lastHeartbeat(pool);
      expect(beat?.startedAt).toEqual(startedAt);
      const running = await app.get("/healthz/worker");
      expect(running.status).toBe(200);
      expect(await running.json()).toEqual({
        status: "running",
        lastSeen: beat!.seenAt.toISOString(),
      });

      // A later check-in updates the one row; it never adds another.
      await recordHeartbeat(pool, startedAt);
      expect((await pool.query("SELECT count(*)::int AS n FROM worker_heartbeat")).rows[0]).toEqual(
        { n: 1 },
      );

      await pool.query("UPDATE worker_heartbeat SET seen_at = now() - interval '10 minutes'");
      const down = await app.get("/healthz/worker");
      expect(down.status).toBe(503);
      expect(await down.json()).toMatchObject({ status: "down" });
    } finally {
      // Leave a fresh check-in, as a running worker would.
      await recordHeartbeat(pool, new Date());
      await app.stop();
    }
  });

  it("lets the app role check in but not delete the check-in", async () => {
    await recordHeartbeat(pool, new Date());
    await expect(pool.query("DELETE FROM worker_heartbeat")).rejects.toThrow(/permission denied/);
  });
});
