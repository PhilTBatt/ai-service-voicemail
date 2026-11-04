import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { createPool } from "./db/pool.ts";
import { TEST_DATABASE_URL } from "./testing/databases.ts";

// Nothing listens on port 1, so connections are refused: a real "database is down".
const DOWN_DATABASE_URL = "postgres://callmate_app:callmate_app@127.0.0.1:1/callmate";

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

  it("returns 200 when the database is reachable", async () => {
    const get = await startApp(TEST_DATABASE_URL);
    const response = await get("/readyz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready" });
  });
});
