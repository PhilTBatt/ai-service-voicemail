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

describe("browser protections", () => {
  it("are on every response, and the server doesn't name itself", async () => {
    const get = await startApp(DOWN_DATABASE_URL);
    // Express's own 404 page replaces the policy with its stricter one; the rest stay.
    const policies = {
      "/healthz": "frame-ancestors 'none'",
      "/readyz": "frame-ancestors 'none'",
      "/nothing": "default-src 'none'",
    };
    for (const [path, policy] of Object.entries(policies)) {
      const { headers } = await get(path);
      expect(headers.get("x-frame-options")).toBe("DENY");
      expect(headers.get("content-security-policy")).toBe(policy);
      expect(headers.get("x-content-type-options")).toBe("nosniff");
      expect(headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
      expect(headers.get("strict-transport-security")).toBe("max-age=31536000");
      expect(headers.get("x-powered-by")).toBeNull();
    }
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

  it("says starting, not ready, while the job queue is still connecting, with its build", async () => {
    let queueUp = false;
    const pool = createPool(TEST_DATABASE_URL);
    const server = createApp({ pool, ready: () => queueUp, version: "abc123" }).listen(0);
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    try {
      const starting = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(starting.status).toBe(503);
      expect(await starting.json()).toEqual({ status: "starting", version: "abc123" });
      queueUp = true;
      const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toEqual({ status: "ready", version: "abc123" });
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await pool.end();
    }
  });
});

describe("serving the built dashboard (production)", () => {
  /** A stand-in for apps/web/dist: the page and one hashed asset. */
  function fakeDist(
    page = "<!doctype html><html><head><title>AnswerMate</title></head><body></body></html>",
  ) {
    const dir = mkdtempSync(path.join(tmpdir(), "callmate-dist-"));
    writeFileSync(path.join(dir, "index.html"), page);
    mkdirSync(path.join(dir, "assets"));
    writeFileSync(path.join(dir, "assets", "index-abc123.js"), "console.log('dashboard')");
    return dir;
  }

  async function startWithDashboard(
    moveDashboard?: { fromHost: string; toOrigin: string },
    page?: string,
  ) {
    const pool = createPool(TEST_DATABASE_URL);
    const server = createApp({ pool, dashboardDist: fakeDist(page), moveDashboard }).listen(0);
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

  describe("while the API moves address", () => {
    const move = { fromHost: "callmate-api.example.net", toOrigin: "https://app.example.com" };
    const script =
      '<script>if (location.host.toLowerCase() === "callmate-api.example.net") ' +
      'location.replace("https://app.example.com" + location.pathname + location.search + location.hash)</script></head>';

    it("gives the page a line that sends a browser on the old address to the same path at the new one", async () => {
      const request = await startWithDashboard(move);
      for (const route of ["/", "/tenants/abc"]) {
        const response = await request(route);
        expect(response.status, route).toBe(200);
        expect(response.headers.get("cache-control"), route).toBe("no-cache");
        const html = await response.text();
        expect(html, route).toContain("<title>AnswerMate</title>");
        expect(html, route).toContain(script);
      }
      // Not a page: health checks and the hashed files are as they were.
      expect(await (await request("/healthz")).json()).toEqual({ status: "ok" });
      expect(await (await request("/assets/index-abc123.js")).text()).toBe(
        "console.log('dashboard')",
      );
    });

    it("puts the line after the doctype in a page with no head, never before it", async () => {
      const request = await startWithDashboard(move, "<!DOCTYPE html><title>AnswerMate</title>");
      expect(await (await request("/")).text()).toBe(
        `<!DOCTYPE html>${script.replace("</head>", "")}<title>AnswerMate</title>`,
      );
    });

    it("leaves the page alone with no move, or a move from an address to itself", async () => {
      for (const app of [
        await startWithDashboard(),
        await startWithDashboard({
          fromHost: "APP.example.com",
          toOrigin: "https://app.example.com",
        }),
      ]) {
        expect(await (await app("/")).text()).not.toContain("<script>");
      }
    });
  });
});
