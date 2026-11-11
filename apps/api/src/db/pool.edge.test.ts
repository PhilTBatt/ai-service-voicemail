// The pool settings db/pool.ts promises, checked against the real test database: its size, the
// statement timeout Postgres actually applies, giving up on a connection after two seconds
// rather than hanging, and surviving a dropped idle connection.
import { afterAll, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import { createAdminPool } from "./cross-tenant.ts";
import { ADMIN_POOL_MAX, APP_POOL_MAX, WORKER_ADMIN_POOL_MAX, createPool } from "./pool.ts";

const opened: { end: () => Promise<void> }[] = [];
/** Every pool made here is closed at the end, whatever a test did with it. */
function track<T extends { end: () => Promise<void> }>(pool: T): T {
  opened.push(pool);
  return pool;
}

afterAll(async () => {
  await Promise.all(opened.map((pool) => pool.end().catch(() => undefined)));
});

describe("createPool", () => {
  it("sizes the app pool at APP_POOL_MAX unless told otherwise", () => {
    expect(track(createPool(TEST_DATABASE_URL)).options.max).toBe(APP_POOL_MAX);
    expect(track(createPool(TEST_DATABASE_URL, { max: 7 })).options.max).toBe(7);
  });

  it("sizes the admin pool at ADMIN_POOL_MAX, and the worker's at its own size", () => {
    expect(track(createAdminPool(TEST_ADMIN_DATABASE_URL)).options.max).toBe(ADMIN_POOL_MAX);
    expect(
      track(createAdminPool(TEST_ADMIN_DATABASE_URL, { max: WORKER_ADMIN_POOL_MAX })).options.max,
    ).toBe(WORKER_ADMIN_POOL_MAX);
  });

  it("has Postgres stop any statement after 10 seconds", async () => {
    const pool = track(createPool(TEST_DATABASE_URL));
    const { rows } = await pool.query<{ statement_timeout: string }>("SHOW statement_timeout");
    expect(rows[0]?.statement_timeout).toBe("10s");
  });

  it("cancels a statement that outlasts its timeout, rather than holding the request", async () => {
    const pool = track(createPool(TEST_DATABASE_URL));
    const client = await pool.connect();
    try {
      // The pool's 10 seconds, shortened for this one transaction so the test is quick.
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '200ms'");
      await expect(client.query("SELECT pg_sleep(5)")).rejects.toMatchObject({ code: "57014" });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("gives up waiting for a connection after about two seconds when the pool is full", async () => {
    const pool = track(createPool(TEST_DATABASE_URL, { max: 1 }));
    const held = await pool.connect();
    try {
      const started = Date.now();
      await expect(pool.query("SELECT 1")).rejects.toThrow(/timeout/i);
      const waited = Date.now() - started;
      expect(waited).toBeGreaterThanOrEqual(1_900);
      expect(waited).toBeLessThan(5_000);
    } finally {
      held.release();
    }
    // And the pool works again once the connection is back.
    await expect(pool.query("SELECT 1 AS one")).resolves.toMatchObject({ rows: [{ one: 1 }] });
  }, 10_000);

  it("fails fast when nothing is listening, rather than waiting forever", async () => {
    // Port 1 on this machine: nothing listens there, so the connection is refused.
    const pool = track(createPool("postgres://callmate_app@127.0.0.1:1/callmate_test"));
    const started = Date.now();
    await expect(pool.query("SELECT 1")).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  it("logs an idle connection's error instead of crashing the process", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    const pool = track(createPool(TEST_DATABASE_URL));
    // With no listener, an "error" event throws: this is the database restarting under us.
    expect(pool.listenerCount("error")).toBe(1);
    expect(() => pool.emit("error", new Error("terminating connection"), undefined)).not.toThrow();
    expect(warn).toHaveBeenCalledWith("Idle database connection failed", {
      error: expect.objectContaining({ message: "terminating connection" }) as unknown,
    });
    warn.mockRestore();
  });

  it("connects lazily: making a pool opens no connection", () => {
    const pool = track(createPool("postgres://callmate_app@127.0.0.1:1/callmate_test"));
    expect(pool.totalCount).toBe(0);
  });
});
