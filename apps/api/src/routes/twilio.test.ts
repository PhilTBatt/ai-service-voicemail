import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { assignPhoneNumber, createAdminPool, createTenant } from "../db/cross-tenant.ts";
import { createPool } from "../db/pool.ts";
import { FakeTelephonyProvider } from "../providers/telephony.fake.ts";
import { FakeVoiceProvider } from "../providers/voice.fake.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";

// The public URL Twilio signs for, which is not where the test server listens: the route
// must verify against PUBLIC_BASE_URL, never the request's own host.
const PUBLIC_BASE_URL = "https://callmate.example.com";
const NOW = () => new Date("2026-07-15T10:00:00Z"); // Wednesday 11:00 BST

const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);
const telephony = new FakeTelephonyProvider();
const voice = new FakeVoiceProvider();
let post: (
  path: string,
  params: Record<string, string>,
  signatureFor?: string,
) => Promise<Response>;
let stop: () => Promise<void>;
let baseUrl: string;

beforeAll(async () => {
  const server = createApp({
    pool: app,
    telephony: { provider: telephony, voice, publicBaseUrl: PUBLIC_BASE_URL, now: NOW },
  }).listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  post = (path, params, signatureFor = `${PUBLIC_BASE_URL}${path}`) =>
    fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": telephony.sign(signatureFor, params),
      },
      body: new URLSearchParams(params).toString(),
    });
  stop = () => new Promise((resolve) => server.close(() => resolve()));
});

afterAll(async () => {
  await stop();
  await Promise.all([app.end(), admin.end()]);
});

afterEach(async () => {
  await admin.query("UPDATE system_settings SET kill_switch_on = false");
});

/** A fictional tenant on a drama number, with a synced agent unless told otherwise. */
async function makeTenant(
  status: "live" | "demo" | "paused" | "suspended" | "cancelling" | "cancelled" | "onboarding",
  { synced = true } = {},
) {
  const tenantId = await createTenant(admin, {
    businessName: "Routing Plumbing",
    contactName: "Sam",
    trade: "plumber",
    status: status === "demo" ? "demo" : "onboarding",
    notificationMobile: "+447700900001",
  });
  if (status !== "demo" && status !== "onboarding") {
    await admin.query("UPDATE tenants SET status = $2 WHERE id = $1", [tenantId, status]);
  }
  const number = `+442079460${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
  await admin.query(
    "UPDATE phone_numbers SET status = 'released', released_at = now() WHERE number = $1 AND status = 'active'",
    [number],
  );
  await assignPhoneNumber(admin, tenantId, number, `PN${randomUUID()}`);
  if (synced) {
    const { providerAgentId } = await voice.upsertAgent({
      definition: {
        ...(await import("../testing/agent-fixture.ts")).sampleAgentDefinition(),
        tenantId,
      },
      existingProviderAgentId: null,
    });
    await admin.query(
      `INSERT INTO agent_profiles (tenant_id, version, trade_template, opening_hours, provider_agent_id, synced_at)
       VALUES ($1, 1, 'plumber', $2, $3, now())`,
      [tenantId, JSON.stringify({ wed: { open: "08:00", close: "18:00" } }), providerAgentId],
    );
  }
  return { tenantId, number };
}

const call = (to: string, from = "+447700900123") => ({
  CallSid: `CA${randomUUID().replace(/-/g, "")}`,
  To: to,
  From: from,
});

describe("POST /webhooks/twilio/voice", () => {
  it("connects a live tenant's caller to the agent, passing the per-call variables", async () => {
    const { number } = await makeTenant("live");
    const response = await post("/webhooks/twilio/voice", call(number));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/xml");
    const xml = await response.text();
    expect(xml).toContain("<Dial");
    expect(xml).toMatch(/<Sip>sip:fake_call_\d+@fake\.invalid<\/Sip>/);
    expect(xml).toContain(`action="${PUBLIC_BASE_URL}/webhooks/twilio/dial-status"`);
    expect(voice.calls.at(-1)).toMatchObject({
      from: "+447700900123",
      to: number,
      variables: { open_now: "yes", holiday_mode: "no" },
    });
  });

  it("treats a withheld caller number as unknown rather than failing", async () => {
    const { number } = await makeTenant("demo");
    expect((await post("/webhooks/twilio/voice", call(number, "anonymous"))).status).toBe(200);
    expect(voice.calls.at(-1)).toMatchObject({ from: null, to: number });
  });

  it.each(["paused", "suspended", "onboarding"] as const)(
    "sends a %s tenant's caller to the voicemail",
    async (status) => {
      const { number } = await makeTenant(status);
      const xml = await (await post("/webhooks/twilio/voice", call(number))).text();
      expect(xml).toContain("Sorry, the assistant isn't available right now.");
      expect(xml).toContain(`<Record action="${PUBLIC_BASE_URL}/webhooks/twilio/recording"`);
    },
  );

  it.each(["cancelling", "cancelled"] as const)(
    "tells a %s tenant's caller the service has ended, with the mobile",
    async (status) => {
      const { number } = await makeTenant(status);
      const xml = await (await post("/webhooks/twilio/voice", call(number))).text();
      expect(xml).toContain("This service has ended. Please call");
      expect(xml).toContain('<say-as interpret-as="telephone">07700 900001</say-as>');
    },
  );

  it("sends everyone to the voicemail while the kill switch is on", async () => {
    const { number } = await makeTenant("live");
    await admin.query("UPDATE system_settings SET kill_switch_on = true");
    const xml = await (await post("/webhooks/twilio/voice", call(number))).text();
    expect(xml).toContain("<Record");
    expect(xml).not.toContain("<Dial");
  });

  it("rejects a caller the tenant has blocked", async () => {
    const { tenantId, number } = await makeTenant("live");
    await admin.query(
      "INSERT INTO blocked_numbers (tenant_id, number) VALUES ($1, '+447700900666')",
      [tenantId],
    );
    const xml = await (await post("/webhooks/twilio/voice", call(number, "+447700900666"))).text();
    expect(xml).toContain('<Reject reason="rejected"');
  });

  it("sends a live tenant whose agent never synced to the voicemail, not dead air", async () => {
    const { number } = await makeTenant("live", { synced: false });
    const xml = await (await post("/webhooks/twilio/voice", call(number))).text();
    expect(xml).toContain("<Record");
  });

  it("sends a number nobody owns to the voicemail", async () => {
    const xml = await (await post("/webhooks/twilio/voice", call("+441632960999"))).text();
    expect(xml).toContain("<Record");
  });

  it("falls back to the voicemail when the voice platform can't register the call", async () => {
    const { number } = await makeTenant("live");
    const register = voice.registerInboundCall.bind(voice);
    voice.registerInboundCall = () => Promise.reject(new Error("Retell is down"));
    try {
      const response = await post("/webhooks/twilio/voice", call(number));
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("<Record");
    } finally {
      voice.registerInboundCall = register;
    }
  });

  it("refuses a request that was signed for a different URL (the public URL must match)", async () => {
    const { number } = await makeTenant("live");
    const response = await post(
      "/webhooks/twilio/voice",
      call(number),
      "http://localhost:3000/webhooks/twilio/voice",
    );
    expect(response.status).toBe(403);
  });

  it("refuses a body changed after signing", async () => {
    const { number } = await makeTenant("live");
    const params = call(number);
    const response = await fetch(`${baseUrl}/webhooks/twilio/voice`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": telephony.sign(`${PUBLIC_BASE_URL}/webhooks/twilio/voice`, params),
      },
      body: new URLSearchParams({ ...params, From: "+447700900999" }).toString(),
    });
    expect(response.status).toBe(403);
  });
});

describe("POST /webhooks/twilio/dial-status", () => {
  it("hangs up after a completed agent leg", async () => {
    const xml = await (
      await post("/webhooks/twilio/dial-status", { CallSid: "CA1", DialCallStatus: "completed" })
    ).text();
    expect(xml).toContain("<Hangup/>");
  });

  it.each(["failed", "busy", "no-answer", "canceled"])(
    "plays the voicemail when the agent leg ended with %s",
    async (status) => {
      const xml = await (
        await post("/webhooks/twilio/dial-status", { CallSid: "CA1", DialCallStatus: status })
      ).text();
      expect(xml).toContain("<Record");
    },
  );
});
