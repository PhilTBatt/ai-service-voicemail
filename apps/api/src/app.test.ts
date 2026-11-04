import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { createPool } from "./db.ts";

// The Docker test database (npm run db:up). CI points TEST_DATABASE_URL at its own Postgres.
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://callmate:callmate@127.0.0.1:5433/callmate_test";

// Nothing listens on port 1, so connections are refused: a real "database is down".
const DOWN_DATABASE_URL = "postgres://callmate:callmate@127.0.0.1:1/callmate";

const running: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((stop) => stop()));
});

/** Starts the real app on a random free port, backed by a real pool. */
async function startApp(databaseUrl: string) {
  const pool = createPool(databaseUrl);
  const server = createApp({ pool }).listen(0);
  await once(server, "listening");
  running.push(async () => {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  });
  const { port } = server.address() as AddressInfo;
  return (path: string) => fetch(`http://127.0.0.1:${port}${path}`);
}

describe("GET /healthz", () => {
  it("returns 200 even when the database is down", async () => {
    const get = await startApp(DOWN_DATABASE_URL);
    const response = await get("/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});

describe("GET /readyz", () => {
  it("returns 503 without error details when the database is down", async () => {
    const get = await startApp(DOWN_DATABASE_URL);
    const response = await get("/readyz");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unavailable" });
  });

  describe("with the test database running", () => {
    beforeAll(async () => {
      const pool = createPool(TEST_DATABASE_URL);
      try {
        await pool.query("SELECT 1");
      } catch (cause) {
        throw new Error("Test database unreachable. Start it with: npm run db:up", { cause });
      } finally {
        await pool.end();
      }
    });

    it("returns 200", async () => {
      const get = await startApp(TEST_DATABASE_URL);
      const response = await get("/readyz");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ready" });
    });
  });
});
