import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { createPool } from "./db/pool.ts";
import { TEST_DATABASE_URL } from "./testing/databases.ts";

// Nothing listens on port 1, so connections are refused: a real "database is down".
const DOWN_DATABASE_URL = "postgres://callmate_app@127.0.0.1:1/callmate";

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

describe("serving the built dashboard (production)", () => {
  /** A stand-in for apps/web/dist: the page and one hashed asset. */
  function fakeDist() {
    const dir = mkdtempSync(path.join(tmpdir(), "callmate-dist-"));
    writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>AnswerMate</title>");
    mkdirSync(path.join(dir, "assets"));
    writeFileSync(path.join(dir, "assets", "index-abc123.js"), "console.log('dashboard')");
    return dir;
  }

  async function startWithDashboard() {
    const pool = createPool(TEST_DATABASE_URL);
    const server = createApp({ pool, dashboardDist: fakeDist() }).listen(0);
    await once(server, "listening");
    running.push(async () => {
      await new Promise((resolve) => server.close(resolve));
      await pool.end();
    });
    const { port } = server.address() as AddressInfo;
    return (path: string, method = "GET") => fetch(`http://127.0.0.1:${port}${path}`, { method });
  }

  it("serves the dashboard's page at / and at its own routes, never cached", async () => {
    const request = await startWithDashboard();
    for (const route of ["/", "/tenants/abc", "/admin", "/calls-today"]) {
      const response = await request(route);
      expect(response.status, route).toBe(200);
      expect(await response.text(), route).toContain("<title>AnswerMate</title>");
      expect(response.headers.get("cache-control"), route).toBe("no-cache");
    }
  });

  it("serves its hashed files with a year-long cache", async () => {
    const response = await (await startWithDashboard())("/assets/index-abc123.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("leaves the API's own paths alone: an unknown one is a 404, not the dashboard", async () => {
    const request = await startWithDashboard();
    for (const route of ["/api/nothing", "/webhooks/nothing", "/c/nothing", "/healthz/nothing"]) {
      const response = await request(route);
      expect(response.status, route).toBe(404);
      expect(await response.text(), route).not.toContain("AnswerMate");
    }
    expect(await (await request("/healthz")).json()).toEqual({ status: "ok" });
    expect((await request("/", "POST")).status).toBe(404);
  });
});
