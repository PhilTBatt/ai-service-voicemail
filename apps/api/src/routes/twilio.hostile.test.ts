// Twilio's webhooks given what a probe, a withheld caller or an odd text could send: every call
// still hears something (the fallback voicemail when in doubt), every reply is safe XML, and a
// late or unknown delivery receipt changes nothing it shouldn't.
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { parseAllowlist } from "../core/outbound-allowlist.ts";
import { FALLBACK_VOICEMAIL_GREETING } from "../core/scripts.ts";
import { assignPhoneNumber, createAdminPool, createTenant } from "../db/cross-tenant.ts";
import { createPool } from "../db/pool.ts";
import { FakeTelephonyProvider } from "../providers/telephony.fake.ts";
import { FakeVoiceProvider } from "../providers/voice.fake.ts";
import { sampleAgentDefinition } from "../testing/agent-fixture.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import { bandMobile } from "../testing/drama-mobiles.ts";
import {
  GLOBAL_SETTINGS_LOCK_TIMEOUT_MS,
  holdGlobalSettings,
} from "../testing/global-settings-lock.ts";

const PUBLIC_BASE_URL = "https://callmate.example.com";
const NOW = new Date("2026-07-15T10:00:00Z"); // Wednesday 11:00 BST
/** This file's band of the drama mobiles: 07700 900400 to 900449, used by no other test file. */
const BAND = [400, 449] as const;

const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);
const telephony = new FakeTelephonyProvider();
const voice = new FakeVoiceProvider();
const enqueueSync = vi.fn(() => Promise.resolve());
const enqueueNotifications = vi.fn(() => Promise.resolve());
let allowlist = parseAllowlist(undefined);
let baseUrl: string;
let stop: () => Promise<void>;

// Routing reads the kill switch, which other files turn on: take turns with them.
let releaseGlobalSettings: () => Promise<void>;
beforeAll(async () => {
  releaseGlobalSettings = await holdGlobalSettings();
}, GLOBAL_SETTINGS_LOCK_TIMEOUT_MS);
afterAll(async () => {
  await releaseGlobalSettings();
});

beforeAll(async () => {
  const server = createApp({
    pool: app,
    telephony: {
      provider: telephony,
      voice,
      publicBaseUrl: PUBLIC_BASE_URL,
      // A getter, so a test can put a mobile on the allowlist after the app is built.
      outbound: {
        nodeEnv: "test",
        get allowlist() {
          return allowlist;
        },
      },
      enqueueSync,
      enqueueNotifications,
      alert: vi.fn(),
      now: () => NOW,
      registerTimeoutMs: 300,
    },
  }).listen(0);
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stop = () => new Promise((resolve) => server.close(() => resolve()));
});

afterAll(async () => {
  await stop();
  await Promise.all([app.end(), admin.end()]);
});

function post(
  path: string,
  params: Record<string, string>,
  {
    signatureFor = `${PUBLIC_BASE_URL}${path}`,
    signature,
  }: { signatureFor?: string; signature?: string } = {},
) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature ?? telephony.sign(signatureFor, params),
    },
    body: new URLSearchParams(params).toString(),
  });
}

/** A live tenant on a Nottingham drama number (0115 496 0xxx), which no other test file uses. */
async function makeTenant({ mobile = null as string | null } = {}) {
  const tenantId = await createTenant(admin, {
    businessName: "Hostile Heating",
    contactName: "Sam",
    trade: "plumber",
    ...(mobile !== null && { notificationMobile: mobile }),
  });
  await admin.query("UPDATE tenants SET status = 'live' WHERE id = $1", [tenantId]);
  const number = `+441154960${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
  await admin.query(
    "UPDATE phone_numbers SET status = 'released', released_at = now() WHERE number = $1 AND status = 'active'",
    [number],
  );
  await assignPhoneNumber(admin, tenantId, number, `PN${randomUUID()}`);
  return { tenantId, number };
}

async function addProfile(
  tenantId: string,
  version: number,
  { synced, holidayUntil = null }: { synced: boolean; holidayUntil?: string | null },
) {
  const providerAgentId = synced
    ? (
        await voice.upsertAgent({
          definition: { ...sampleAgentDefinition(), tenantId },
          existingProviderAgentId: null,
        })
      ).providerAgentId
    : null;
  await admin.query(
    `INSERT INTO agent_profiles (tenant_id, version, trade_template, opening_hours, provider_agent_id,
                                 synced_at, holiday_mode, holiday_until)
     VALUES ($1, $2, 'plumber', $3, $4, $5, $6, $7)`,
    [
      tenantId,
      version,
      JSON.stringify({ wed: { open: "08:00", close: "18:00" } }),
      providerAgentId,
      synced ? new Date() : null,
      holidayUntil !== null,
      holidayUntil,
    ],
  );
  return providerAgentId;
}

const callSid = () => `CA${randomUUID().replace(/-/g, "")}`;

describe("POST /webhooks/twilio/voice with odd numbers", () => {
  it.each([
    "<script>alert(1)</script>",
    "+44 115 496 0001",
    "01154960001",
    "x".repeat(5000),
    "+441154960001'; --",
  ])("gives a call to a number it can't place (%j) the fallback voicemail", async (to) => {
    const response = await post("/webhooks/twilio/voice", { CallSid: callSid(), To: to });
    expect(response.status).toBe(200);
    const xml = await response.text();
    expect(xml).toContain(FALLBACK_VOICEMAIL_GREETING);
    expect(xml).toContain("<Record");
  });

  it.each(["anonymous", "+266696687", "", "restricted", "<script>", "07700900123"])(
    "treats a caller ID of %j as withheld, and still connects the call",
    async (from) => {
      const { tenantId, number } = await makeTenant();
      await addProfile(tenantId, 1, { synced: true });
      const response = await post("/webhooks/twilio/voice", {
        CallSid: callSid(),
        To: number,
        From: from,
      });
      expect(await response.text()).toContain("<Dial");
      expect(voice.calls.at(-1)).toMatchObject({
        from: null,
        to: number,
        variables: { caller_number: "unknown" },
      });
    },
  );

  it("refuses a request without the call's details as a bad request (Twilio then plays the bins)", async () => {
    expect((await post("/webhooks/twilio/voice", { To: "+441154960001" })).status).toBe(400);
    expect((await post("/webhooks/twilio/voice", { CallSid: callSid() })).status).toBe(400);
  });
});

describe("POST /webhooks/twilio/voice and the tenant's profile", () => {
  it("uses the latest synced profile, never a newer one still waiting to sync", async () => {
    const { tenantId, number } = await makeTenant();
    const synced = await addProfile(tenantId, 1, { synced: true });
    await addProfile(tenantId, 2, { synced: false });
    await post("/webhooks/twilio/voice", { CallSid: callSid(), To: number, From: "+447700900123" });
    expect(voice.calls.at(-1)).toMatchObject({ providerAgentId: synced, to: number });
  });

  it("sends a tenant whose only profile never synced to the voicemail, not dead air", async () => {
    const { tenantId, number } = await makeTenant();
    await addProfile(tenantId, 1, { synced: false });
    const xml = await (
      await post("/webhooks/twilio/voice", { CallSid: callSid(), To: number })
    ).text();
    expect(xml).toContain("<Record");
    expect(xml).not.toContain("<Dial");
  });

  it.each([
    ["ends today (UK)", "2026-07-15", { holiday_mode: "yes", holiday_until: "until 15 July 2026" }],
    ["ended yesterday", "2026-07-14", { holiday_mode: "no", holiday_until: "not away" }],
  ])("tells the agent about a holiday that %s", async (_what, until, variables) => {
    const { tenantId, number } = await makeTenant();
    await addProfile(tenantId, 1, { synced: true, holidayUntil: until });
    await post("/webhooks/twilio/voice", { CallSid: callSid(), To: number });
    expect(voice.calls.at(-1)).toMatchObject({ to: number, variables });
  });
});

describe("Twilio signatures", () => {
  it("refuses a signature sent twice, and one for the plain-HTTP address", async () => {
    const params = { CallSid: callSid(), To: "+441154960001" };
    const good = telephony.sign(`${PUBLIC_BASE_URL}/webhooks/twilio/voice`, params);
    const twice = await fetch(`${baseUrl}/webhooks/twilio/voice`, {
      method: "POST",
      headers: [
        ["content-type", "application/x-www-form-urlencoded"],
        ["x-twilio-signature", good],
        ["x-twilio-signature", good],
      ],
      body: new URLSearchParams(params).toString(),
    });
    expect(twice.status).toBe(403);
    const http = await post("/webhooks/twilio/voice", params, {
      signatureFor: `${PUBLIC_BASE_URL.replace("https:", "http:")}/webhooks/twilio/voice`,
    });
    expect(http.status).toBe(403);
  });

  it("refuses a request whose query string wasn't signed", async () => {
    const params = { CallSid: callSid(), To: "+441154960001" };
    const response = await fetch(`${baseUrl}/webhooks/twilio/voice?debug=1`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": telephony.sign(`${PUBLIC_BASE_URL}/webhooks/twilio/voice`, params),
      },
      body: new URLSearchParams(params).toString(),
    });
    expect(response.status).toBe(403);
  });

  it.each(["", "not-base64!", "A".repeat(10_000)])(
    "refuses the signature %j",
    async (signature) => {
      const response = await post(
        "/webhooks/twilio/voice",
        { CallSid: callSid(), To: "+441154960001" },
        { signature },
      );
      expect(response.status).toBe(403);
    },
  );
});

describe("POST /webhooks/twilio/sms with odd texts", () => {
  it.each([
    ["markup", "<script>alert(1)</script>"],
    ["an ampersand", "Tom & Jerry"],
    ["emoji", "\u{1F44D}\u{1F44D}"],
    ["a long text", "status ".repeat(230)],
    ["nothing", ""],
  ])("answers a text holding %s with one safe XML message", async (_what, body) => {
    const mobile = await bandMobile(admin, BAND);
    await makeTenant({ mobile });
    allowlist = parseAllowlist(mobile);
    const response = await post("/webhooks/twilio/sms", {
      MessageSid: `SM${randomUUID().replace(/-/g, "")}`,
      From: mobile,
      Body: body,
    });
    expect(response.status).toBe(200);
    const xml = await response.text();
    expect(xml.match(/<Message>/g)).toHaveLength(1);
    expect(xml).not.toContain("<script>");
    expect(xml).toMatch(
      /^<\?xml version="1\.0" encoding="UTF-8"\?><Response><Message>[^<]+<\/Message><\/Response>$/,
    );
  });

  it("ignores the registered mobile written any way but E.164, saying nothing", async () => {
    const mobile = await bandMobile(admin, BAND);
    const { tenantId } = await makeTenant({ mobile });
    allowlist = parseAllowlist(mobile);
    const national = mobile.replace("+44", "0");
    const xml = await (
      await post("/webhooks/twilio/sms", {
        MessageSid: `SM${randomUUID()}`,
        From: national,
        Body: "OFF",
      })
    ).text();
    expect(xml).toBe('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    const { rows } = await admin.query("SELECT status FROM tenants WHERE id = $1", [tenantId]);
    expect(rows).toEqual([{ status: "live" }]);
  });

  // A mobile is confirmed by a code texted to it before it's saved (PROGRESS open question 4),
  // so one on two businesses is really theirs: the command applies to both, named in the reply,
  // rather than being ignored as it used to be.
  it("commands both businesses of a shared mobile, rather than guessing which one it is", async () => {
    const mobile = await bandMobile(admin, BAND);
    const first = await makeTenant({ mobile });
    const second = await makeTenant({ mobile });
    allowlist = parseAllowlist(mobile);
    const xml = await (
      await post("/webhooks/twilio/sms", {
        MessageSid: `SM${randomUUID()}`,
        From: mobile,
        Body: "OFF",
      })
    ).text();
    expect(xml).toContain("<Message>");
    expect(xml.match(/AnswerMate is now OFF/g)).toHaveLength(2);
    const { rows } = await admin.query(
      "SELECT status FROM tenants WHERE id = ANY($1) ORDER BY status",
      [[first.tenantId, second.tenantId]],
    );
    expect(rows).toEqual([{ status: "paused" }, { status: "paused" }]);
  });

  it("pauses once however often Twilio redelivers OFF, with one audit row", async () => {
    const mobile = await bandMobile(admin, BAND);
    const { tenantId } = await makeTenant({ mobile });
    allowlist = parseAllowlist(mobile);
    const messageSid = `SM${randomUUID().replace(/-/g, "")}`;
    const replies: string[] = [];
    for (let i = 0; i < 3; i++) {
      replies.push(
        await (
          await post("/webhooks/twilio/sms", { MessageSid: messageSid, From: mobile, Body: "OFF" })
        ).text(),
      );
    }
    expect(replies[0]).toContain("AnswerMate is now OFF.");
    expect(replies[1]).toContain("AnswerMate is already OFF.");
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'tenant.paused'",
      [tenantId],
    );
    expect(rows).toEqual([{ n: 1 }]);
  });
});

describe("POST /webhooks/twilio/sms-status out of order", () => {
  async function sentText() {
    const { tenantId } = await makeTenant();
    const messageSid = `SM${randomUUID().replace(/-/g, "")}`;
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO calls (tenant_id, provider_call_id, started_at) VALUES ($1, $2, now()) RETURNING id`,
      [tenantId, `call_${randomUUID()}`],
    );
    await admin.query(
      `INSERT INTO notifications (tenant_id, call_id, channel, status, attempts, provider_ref)
       VALUES ($1, $2, 'sms', 'sent', 1, $3)`,
      [tenantId, rows[0]!.id, messageSid],
    );
    const status = async () =>
      (
        await admin.query<{ status: string }>(
          "SELECT status FROM notifications WHERE provider_ref = $1",
          [messageSid],
        )
      ).rows[0]!.status;
    return { messageSid, status };
  }

  it.each([
    "queued",
    "sending",
    "sent",
    "accepted",
    "scheduled",
    "read",
    "receiving",
    "partially_delivered",
  ])("never lets a late %j overwrite a delivered text", async (late) => {
    const { messageSid, status } = await sentText();
    await post("/webhooks/twilio/sms-status", {
      MessageSid: messageSid,
      MessageStatus: "delivered",
    });
    const response = await post("/webhooks/twilio/sms-status", {
      MessageSid: messageSid,
      MessageStatus: late,
    });
    expect(response.status).toBe(204);
    expect(await status()).toBe("delivered");
  });

  it("refuses a receipt with no status, and ignores one for a text it never sent", async () => {
    const { messageSid, status } = await sentText();
    expect(
      (await post("/webhooks/twilio/sms-status", { MessageSid: messageSid, MessageStatus: "" }))
        .status,
    ).toBe(400);
    expect(await status()).toBe("sent");
    expect(
      (
        await post("/webhooks/twilio/sms-status", {
          MessageSid: `SM${randomUUID()}`,
          MessageStatus: "undelivered",
          ErrorCode: "30003",
        })
      ).status,
    ).toBe(204);
  });
});
