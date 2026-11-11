import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PgBoss } from "pg-boss";
import twilio from "twilio";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";
import { createAdminPool } from "./db/cross-tenant.ts";
import { createPool } from "./db/pool.ts";
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

/** Starts the app built from these settings, and asks each route for an answer. */
async function routesOf(env: Record<string, string>, withAdmin: boolean) {
  const app = buildServerApp(loadConfig(env), {
    pool,
    boss,
    admin: withAdmin ? admin : undefined,
  });
  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const ask = async (method: "GET" | "POST", path: string) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method });
    // Express's own 404 for a route that isn't there is HTML; ours are JSON or TwiML.
    const mounted = !(response.headers.get("content-type") ?? "").startsWith("text/html");
    return { status: response.status, mounted };
  };
  try {
    return {
      health: await ask("GET", "/healthz"),
      twilio: await ask("POST", "/webhooks/twilio/voice"),
      voice: await ask("POST", "/webhooks/voice/retell"),
      postmark: await ask("POST", "/webhooks/postmark"),
      gocardless: await ask("POST", "/webhooks/gocardless"),
      callPage: await ask("GET", "/c/not-a-real-token"),
      dashboard: await ask("GET", "/api/me"),
    };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("buildServerApp", () => {
  it("turns every route on once everything is set up, each refusing an unsigned request", async () => {
    const routes = await routesOf(STAND_IN_ENV, true);
    expect(routes).toEqual({
      health: { status: 200, mounted: true },
      twilio: { status: 403, mounted: true }, // Twilio's signature, checked
      voice: { status: 401, mounted: true }, // Retell's signature, checked
      postmark: { status: 401, mounted: true }, // the webhook's password, checked
      gocardless: { status: 498, mounted: true }, // GoCardless's signature, checked
      callPage: { status: 404, mounted: true }, // a token that isn't one
      dashboard: { status: 401, mounted: true }, // a login, required
    });
  });

  it("leaves a route off until its settings are there", async () => {
    const routes = await routesOf({ DATABASE_URL: TEST_DATABASE_URL }, false);
    expect(routes.health).toEqual({ status: 200, mounted: true });
    for (const route of ["twilio", "postmark", "gocardless", "callPage", "dashboard"] as const) {
      expect(routes[route], route).toEqual({ status: 404, mounted: false });
    }
    // The voice webhook's router is always there; with no Retell it knows no provider.
    expect(routes.voice).toEqual({ status: 404, mounted: true });
  });

  // RUNBOOK section 16, step 4: without this wiring, the switch to the new address sends every
  // call to the fallback voicemail until the number is re-pointed.
  it("passes ALTERNATE_BASE_URL to Twilio's signature check and to the dashboard's page", async () => {
    const dist = mkdtempSync(path.join(tmpdir(), "callmate-dist-"));
    writeFileSync(
      path.join(dist, "index.html"),
      "<!doctype html><html><head><title>AnswerMate</title></head><body></body></html>",
    );
    const app = buildServerApp(
      loadConfig({
        ...STAND_IN_ENV,
        PUBLIC_BASE_URL: "https://app.example.com",
        DASHBOARD_ORIGIN: "https://app.example.com",
        ALTERNATE_BASE_URL: "https://callmate-api.example.net",
        DASHBOARD_DIST: dist,
      }),
      { pool, boss, admin },
    );
    const server = app.listen(0);
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    try {
      // A call to a number nobody has, signed by Twilio for the old address: past the
      // signature check (a 403 would mean refused) to routing, which answers with TwiML.
      const params = { CallSid: `CA${"1".repeat(32)}`, To: "+442079460998", From: "+447700900123" };
      const response = await fetch(`http://127.0.0.1:${port}/webhooks/twilio/voice`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": twilio.getExpectedTwilioSignature(
            STAND_IN_ENV.TWILIO_AUTH_TOKEN,
            "https://callmate-api.example.net/webhooks/twilio/voice",
            params,
          ),
        },
        body: new URLSearchParams(params).toString(),
      });
      expect(response.status).not.toBe(403);
      expect(response.headers.get("content-type")).toContain("text/xml");

      const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
      expect(page).toContain('location.host.toLowerCase() === "callmate-api.example.net"');
      expect(page).toContain('location.replace("https://app.example.com"');
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
