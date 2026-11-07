import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { parseAllowlist } from "../core/outbound-allowlist.ts";
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
const enqueueSync = vi.fn(() => Promise.resolve());
const enqueueNotifications = vi.fn(() => Promise.resolve());
// Replies only go to mobiles added here; everyone else is blocked by the allowlist.
const allowlist = parseAllowlist(undefined);
const outbound = { nodeEnv: "test" as const, allowlist };
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
    telephony: {
      provider: telephony,
      voice,
      publicBaseUrl: PUBLIC_BASE_URL,
      outbound,
      enqueueSync,
      enqueueNotifications,
      now: NOW,
    },
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
      expect(xml).toContain(
        `recordingStatusCallback="${PUBLIC_BASE_URL}/webhooks/twilio/recording"`,
      );
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

describe("POST /webhooks/twilio/voicemail-done", () => {
  it("thanks the caller and hangs up", async () => {
    const xml = await (await post("/webhooks/twilio/voicemail-done", { CallSid: "CA1" })).text();
    expect(xml).toContain("Thanks. Goodbye.");
    expect(xml).toContain("<Hangup/>");
  });
});

describe("POST /webhooks/twilio/recording", () => {
  const callback = (callSid: string, status = "completed") => ({
    CallSid: callSid,
    RecordingSid: "RE" + randomUUID().replace(/-/g, ""),
    RecordingUrl: "https://api.twilio.com/2010-04-01/Accounts/AC0/Recordings/RE1",
    RecordingStatus: status,
    RecordingDuration: "35",
  });

  it("stores a completed recording as a fallback voicemail for the dialled number's tenant", async () => {
    const { tenantId, number } = await makeTenant("paused");
    const callSid = "CA" + randomUUID().replace(/-/g, "");
    telephony.callDetails.set(callSid, {
      callSid,
      from: "+447700900123",
      to: number,
      startedAt: new Date("2026-11-06T18:00:00Z"),
      endedAt: new Date("2026-11-06T18:01:00Z"),
      durationSeconds: 60,
    });

    expect((await post("/webhooks/twilio/recording", callback(callSid))).status).toBe(204);
    const { rows } = await admin.query(
      "SELECT tenant_id, via_fallback, billable_seconds, caller_number FROM calls WHERE provider_call_id = $1",
      [callSid],
    );
    expect(rows).toEqual([
      {
        tenant_id: tenantId,
        via_fallback: true,
        billable_seconds: 35,
        caller_number: "+447700900123",
      },
    ]);
    expect(enqueueNotifications).toHaveBeenCalledWith(expect.anything(), {
      tenantId,
      callId: expect.any(String) as string,
      urgency: null,
    });
  });

  it("acknowledges a failed recording without storing anything", async () => {
    const callSid = "CA" + randomUUID().replace(/-/g, "");
    expect((await post("/webhooks/twilio/recording", callback(callSid, "failed"))).status).toBe(
      204,
    );
    expect(
      (await admin.query("SELECT 1 FROM calls WHERE provider_call_id = $1", [callSid])).rowCount,
    ).toBe(0);
  });

  it("acknowledges a recording for a call Twilio no longer knows", async () => {
    const callSid = "CA" + randomUUID().replace(/-/g, "");
    expect((await post("/webhooks/twilio/recording", callback(callSid))).status).toBe(204);
  });

  it("is signed like every other Twilio webhook", async () => {
    const response = await post(
      "/webhooks/twilio/recording",
      callback("CA1"),
      "http://localhost:3000/webhooks/twilio/recording",
    );
    expect(response.status).toBe(403);
  });
});

describe("POST /webhooks/twilio/sms", () => {
  const sms = (from: string, body: string) => ({
    MessageSid: `SM${randomUUID().replace(/-/g, "")}`,
    From: from,
    To: "+447700900900",
    Body: body,
  });
  const status = async (tenantId: string) =>
    (await admin.query<{ status: string }>("SELECT status FROM tenants WHERE id = $1", [tenantId]))
      .rows[0]!.status;
  /** A tenant whose registered mobile is unique, and allowlisted unless told otherwise. */
  async function makeTexter(status: "live" | "paused" = "live", { allowed = true } = {}) {
    const { tenantId } = await makeTenant(status);
    const mobile = `+4477009${String(Math.floor(Math.random() * 100000)).padStart(5, "0")}`;
    await admin.query("UPDATE tenants SET notification_mobile = $2 WHERE id = $1", [
      tenantId,
      mobile,
    ]);
    if (allowed) allowlist.add(mobile);
    return { tenantId, mobile };
  }

  it("applies a command from the tenant's registered mobile and replies", async () => {
    const { tenantId, mobile } = await makeTexter();
    const response = await post("/webhooks/twilio/sms", sms(mobile, "off"));
    expect(response.status).toBe(200);
    const xml = await response.text();
    expect(xml).toContain("<Message>AnswerMate is now OFF.");
    expect(await status(tenantId)).toBe("paused");
  });

  it("re-syncs the agent when holiday mode changes", async () => {
    const { tenantId, mobile } = await makeTexter();
    enqueueSync.mockClear();
    const xml = await (await post("/webhooks/twilio/sms", sms(mobile, "HOLIDAY 12/12"))).text();
    expect(xml).toContain("Holiday mode is on until 12 Dec 2026");
    expect(enqueueSync).toHaveBeenCalledWith({ tenantId, profileVersion: 1 });
  });

  it("ignores an unknown sender with no reply and no change", async () => {
    const { tenantId } = await makeTenant("live");
    const xml = await (await post("/webhooks/twilio/sms", sms("+447700900555", "OFF"))).text();
    expect(xml).toBe('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    expect(await status(tenantId)).toBe("live");
  });

  it("ignores a withheld sender", async () => {
    const xml = await (await post("/webhooks/twilio/sms", sms("anonymous", "OFF"))).text();
    expect(xml).toBe('<?xml version="1.0" encoding="UTF-8"?><Response/>');
  });

  it("applies the command but sends no reply when the allowlist blocks the mobile", async () => {
    const { tenantId, mobile } = await makeTexter("live", { allowed: false });
    const xml = await (await post("/webhooks/twilio/sms", sms(mobile, "OFF"))).text();
    expect(xml).not.toContain("<Message>");
    expect(await status(tenantId)).toBe("paused");
  });

  it("rejects an unsigned text", async () => {
    const response = await fetch(`${baseUrl}/webhooks/twilio/sms`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(sms("+447700900001", "OFF")).toString(),
    });
    expect(response.status).toBe(403);
  });
});

describe("the demo line (POST /webhooks/twilio/voice)", () => {
  it("caps each caller at three calls a day, counting in UK time", async () => {
    const { tenantId, number } = await makeTenant("demo");
    const caller = "+447700900321";
    // Three calls earlier today (NOW is 11:00 BST on 15 July), and one yesterday that doesn't count.
    for (const startedAt of [
      "2026-07-15T06:30:00Z",
      "2026-07-15T08:00:00Z",
      "2026-07-15T09:30:00Z",
      "2026-07-14T22:59:00Z",
    ]) {
      await admin.query(
        `INSERT INTO calls (tenant_id, provider_call_id, caller_number, started_at, ended_at)
         VALUES ($1, $2, $3, $4, $4)`,
        [tenantId, `call_${randomUUID()}`, caller, startedAt],
      );
    }
    const limited = await (await post("/webhooks/twilio/voice", call(number, caller))).text();
    expect(limited).toContain("three calls a day");
    expect(limited).toContain("<Hangup/>");
    expect(limited).not.toContain("<Dial");

    // A different phone is unaffected.
    const other = await (
      await post("/webhooks/twilio/voice", call(number, "+447700900322"))
    ).text();
    expect(other).toContain("<Dial");
  });

  it("doesn't count a caller with two calls today as over the limit", async () => {
    const { tenantId, number } = await makeTenant("demo");
    const caller = "+447700900323";
    for (const startedAt of ["2026-07-15T06:30:00Z", "2026-07-15T08:00:00Z"]) {
      await admin.query(
        `INSERT INTO calls (tenant_id, provider_call_id, caller_number, started_at, ended_at)
         VALUES ($1, $2, $3, $4, $4)`,
        [tenantId, `call_${randomUUID()}`, caller, startedAt],
      );
    }
    expect(await (await post("/webhooks/twilio/voice", call(number, caller))).text()).toContain(
      "<Dial",
    );
  });
});
