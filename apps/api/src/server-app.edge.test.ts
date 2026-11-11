// buildServerApp between all-on and all-off: each route comes on with exactly the settings it
// needs, and not with some of them; the start-up warnings production relies on; and a doubled
// slash in a webhook URL, which the routes don't answer (config.ts strips trailing slashes from
// PUBLIC_BASE_URL for that reason).
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { PgBoss } from "pg-boss";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.ts";
import { createAdminPool } from "./db/cross-tenant.ts";
import { createPool } from "./db/pool.ts";
import { logger } from "./logger.ts";
import { buildServerApp } from "./server-app.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "./testing/databases.ts";
import { STAND_IN_ENV } from "./testing/stand-in-env.ts";

const pool = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);
/** The API only enqueues, and these requests never get that far. */
const boss = { send: () => Promise.resolve(null) } as unknown as PgBoss;

afterAll(async () => {
  await Promise.all([pool.end(), admin.end()]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const BASE = { NODE_ENV: "test", DATABASE_URL: TEST_DATABASE_URL };
const pick = (...names: (keyof typeof STAND_IN_ENV)[]) =>
  Object.fromEntries(names.map((name) => [name, STAND_IN_ENV[name]]));

type Route = "twilio" | "voice" | "postmark" | "gocardless" | "callPage" | "dashboard";
const ROUTES: Record<Route, ["GET" | "POST", string]> = {
  twilio: ["POST", "/webhooks/twilio/voice"],
  voice: ["POST", "/webhooks/voice/retell"],
  postmark: ["POST", "/webhooks/postmark"],
  gocardless: ["POST", "/webhooks/gocardless"],
  callPage: ["GET", "/c/not-a-real-token"],
  dashboard: ["GET", "/api/me"],
};

/** Starts the app built from these settings; for each route, whether it's there and what it said. */
async function routesOf(env: Record<string, string>, withAdmin: boolean, paths = ROUTES) {
  const app = buildServerApp(loadConfig(env), {
    pool,
    boss,
    admin: withAdmin ? admin : undefined,
  });
  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    const results: Record<string, { status: number; mounted: boolean }> = {};
    for (const [route, [method, path]] of Object.entries(paths)) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method });
      await response.arrayBuffer();
      // Express's own 404 for a route that isn't there is HTML; ours are JSON or TwiML.
      const mounted = !(response.headers.get("content-type") ?? "").startsWith("text/html");
      results[route] = { status: response.status, mounted };
    }
    return results;
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

const OFF = { status: 404, mounted: false };

describe("each route needs all of its settings", () => {
  it("call routing: Twilio, the public URL and Retell together; any two leave it off", async () => {
    const all = pick(
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "PUBLIC_BASE_URL",
      "RETELL_API_KEY",
    );
    expect((await routesOf({ ...BASE, ...all }, false)).twilio).toEqual({
      status: 403,
      mounted: true,
    });
    for (const missing of ["TWILIO_AUTH_TOKEN", "PUBLIC_BASE_URL", "RETELL_API_KEY"]) {
      const env: Record<string, string> = { ...BASE, ...all };
      delete env[missing];
      expect((await routesOf(env, false)).twilio, `without ${missing}`).toEqual(OFF);
    }
  });

  it("Retell's webhook: on with the Retell key alone, checking its signature", async () => {
    const routes = await routesOf({ ...BASE, ...pick("RETELL_API_KEY") }, false);
    expect(routes["voice"]).toEqual({ status: 401, mounted: true });
    expect(routes["twilio"]).toEqual(OFF);
  });

  it("the dashboard API: Clerk and the admin pool together; either alone leaves it off", async () => {
    const clerk = pick("CLERK_SECRET_KEY");
    expect((await routesOf({ ...BASE, ...clerk }, true))["dashboard"]).toEqual({
      status: 401,
      mounted: true,
    });
    expect((await routesOf({ ...BASE, ...clerk }, false))["dashboard"]).toEqual(OFF);
    expect((await routesOf(BASE, true))["dashboard"]).toEqual(OFF);
  });

  it("call pages: on with the signing secret alone", async () => {
    const routes = await routesOf({ ...BASE, ...pick("SIGNING_SECRET") }, false);
    expect(routes["callPage"]).toEqual({ status: 404, mounted: true });
  });

  it("Postmark's webhook: on with its password alone, refusing a request without it", async () => {
    const routes = await routesOf({ ...BASE, ...pick("POSTMARK_WEBHOOK_SECRET") }, false);
    expect(routes["postmark"]).toEqual({ status: 401, mounted: true });
  });

  it("GoCardless's webhook: on with the token, and refusing everything without its secret", async () => {
    const routes = await routesOf({ ...BASE, ...pick("GOCARDLESS_ACCESS_TOKEN") }, false);
    // No secret to check a signature with: every webhook is refused as unsigned.
    expect(routes["gocardless"]).toEqual({ status: 498, mounted: true });
  });

  it("only the health check without any of them", async () => {
    const routes = await routesOf(BASE, false, {
      ...ROUTES,
      health: ["GET", "/healthz"],
    } as typeof ROUTES);
    expect(routes["health"]).toEqual({ status: 200, mounted: true });
    for (const route of ["twilio", "postmark", "gocardless", "callPage", "dashboard"]) {
      expect(routes[route], route).toEqual(OFF);
    }
  });
});

describe("webhook URLs with a doubled slash", () => {
  // What a PUBLIC_BASE_URL of "https://host//" used to produce, before config.ts stripped every
  // trailing slash: the provider calls "//webhooks/...", and nothing answers there.
  it("are answered by no route, which is why the public URL must never end in a slash", async () => {
    const routes = await routesOf(STAND_IN_ENV, true, {
      twilio: ["POST", "//webhooks/twilio/voice"],
      voice: ["POST", "//webhooks/voice/retell"],
    } as typeof ROUTES);
    expect(routes["twilio"]?.status).toBe(404);
    expect(routes["voice"]?.status).toBe(404);
  });
});

describe("the start-up log", () => {
  const PRODUCTION = {
    ...STAND_IN_ENV,
    NODE_ENV: "production",
  };

  function warningsFor(env: Record<string, string>, withAdmin = true): string[] {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    const info = vi.spyOn(logger, "info").mockImplementation(() => logger);
    buildServerApp(loadConfig(env), { pool, boss, admin: withAdmin ? admin : undefined });
    const messages = warn.mock.calls.map(([message]) =>
      typeof message === "string" ? message : "",
    );
    // Restored at once: one test builds several apps, and each must be heard alone.
    warn.mockRestore();
    info.mockRestore();
    return messages;
  }

  it("warns in production that payments are on the sandbox, where no money moves", () => {
    expect(warningsFor(PRODUCTION)).toContain(
      "Payments are on GoCardless's sandbox: no real money moves (GOCARDLESS_ENVIRONMENT)",
    );
    expect(warningsFor({ ...PRODUCTION, GOCARDLESS_ENVIRONMENT: "live" })).not.toContain(
      "Payments are on GoCardless's sandbox: no real money moves (GOCARDLESS_ENVIRONMENT)",
    );
    // Outside production the sandbox is expected: no warning.
    expect(warningsFor(STAND_IN_ENV).join("\n")).not.toContain("sandbox");
  });

  it("warns in production when Retell's webhooks are checked with the API key", () => {
    const warning = expect.stringMatching(/^RETELL_WEBHOOK_KEY isn't set/) as unknown;
    expect(warningsFor(PRODUCTION)).toContainEqual(warning);
    expect(
      warningsFor({ ...PRODUCTION, RETELL_WEBHOOK_KEY: "badge_key_for_tests" }),
    ).not.toContainEqual(warning);
  });

  it("warns when GoCardless's webhooks will all be refused for want of the secret", () => {
    const env: Record<string, string> = { ...STAND_IN_ENV };
    delete env["GOCARDLESS_WEBHOOK_SECRET"];
    expect(warningsFor(env)).toContain(
      "Payments webhooks refused: GOCARDLESS_WEBHOOK_SECRET isn't set",
    );
  });

  it("names every missing setting for each feature that's off", () => {
    expect(warningsFor(BASE, false)).toEqual(
      expect.arrayContaining([
        "RETELL_API_KEY not set: voice webhooks are disabled",
        "Call routing disabled: needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, PUBLIC_BASE_URL and RETELL_API_KEY",
        "Call pages disabled: SIGNING_SECRET isn't set",
        "Billing disabled: GOCARDLESS_ACCESS_TOKEN isn't set",
        "Dashboard API disabled: needs CLERK_SECRET_KEY and ADMIN_DATABASE_URL",
      ]),
    );
  });

  it("warns about nothing when everything is set up", () => {
    expect(warningsFor({ ...STAND_IN_ENV, RETELL_WEBHOOK_KEY: "badge_key_for_tests" })).toEqual([]);
  });
});
