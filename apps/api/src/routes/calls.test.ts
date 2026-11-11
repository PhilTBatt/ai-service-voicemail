import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { CALL_LINK_TTL_MS, signCallLink } from "../core/signed-links.ts";
import { createAdminPool, createTenant } from "../db/cross-tenant.ts";
import { createPool } from "../db/pool.ts";
import { FakeTelephonyProvider } from "../providers/telephony.fake.ts";
import { FakeVoiceProvider } from "../providers/voice.fake.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";

const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);
const telephony = new FakeTelephonyProvider();
const voice = new FakeVoiceProvider();
const SECRET = "test-signing-secret-at-least-32-characters-long";
const NOW = new Date("2026-11-07T10:00:00Z");

let get: (path: string) => Promise<Response>;
/** As a phone's browser asks: HTML first. */
let getPage: (path: string) => Promise<Response>;
let stop: () => Promise<void>;

// What browsers send for a page they navigate to.
const BROWSER_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

beforeAll(async () => {
  const server = createApp({
    pool: app,
    callPages: {
      signingSecret: SECRET,
      telephony,
      voice,
      dashboardOrigin: "https://app.example.com",
      now: () => NOW,
    },
  }).listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  get = (path) => fetch(`http://127.0.0.1:${port}${path}`, { redirect: "manual" });
  getPage = (path) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      redirect: "manual",
      headers: { accept: BROWSER_ACCEPT },
    });
  stop = () => new Promise((resolve) => server.close(() => resolve()));
});

afterAll(async () => {
  await stop();
  await Promise.all([app.end(), admin.end()]);
});

const token = (callId: string, expiresAt = new Date(NOW.getTime() + CALL_LINK_TTL_MS)) =>
  signCallLink({ callId, expiresAt }, SECRET);

async function makeCall(kind: "agent" | "voicemail", { recorded = true } = {}) {
  const providerCallId = kind === "agent" ? `call_${randomUUID()}` : `CA${randomUUID()}`;
  // Each voicemail gets its own recording, so one test's audio can't leak into another's.
  const recordingUrl = `https://api.twilio.com/2010-04-01/Accounts/AC0/Recordings/RE${randomUUID().replace(/-/g, "")}`;
  const tenantId = await createTenant(admin, { businessName: "Page Plumbing", trade: "plumber" });
  const { rows } = await admin.query<{ id: string }>(
    kind === "agent"
      ? `INSERT INTO calls (tenant_id, provider_call_id, caller_number, started_at, ended_at,
                            billable_seconds, transcript, summary, urgency, flags, extracted_fields, recording_ref)
         VALUES ($1, $2, '+447700900123', '2026-11-07T09:00:00Z', '2026-11-07T09:02:00Z', 120,
                 E'agent: Hi, how can I help?\\ncaller: My boiler is leaking.', 'Boiler leaking.',
                 'urgent', '{"mentioned leak"}',
                 '{"callerName":"Sam","callbackNumber":"+447700900123","postcode":"XQ12 3JL","guardrailHits":[]}', $3)
         RETURNING id`
      : `INSERT INTO calls (tenant_id, provider_call_id, caller_number, started_at, ended_at,
                            billable_seconds, outcome, recording_ref, via_fallback)
         VALUES ($1, $2, '+447700900123', '2026-11-07T09:00:00Z', '2026-11-07T09:01:00Z', 42,
                 'voicemail', $3, true)
         RETURNING id`,
    kind === "agent"
      ? [tenantId, providerCallId, recorded ? "retell-recording-ref" : null]
      : [tenantId, providerCallId, recordingUrl],
  );
  return { tenantId, callId: rows[0]!.id, recordingUrl, providerCallId };
}

describe("GET /c/:token", () => {
  it("returns the call for a valid link, with the transcript as turns and no provider URL", async () => {
    const { callId } = await makeCall("agent");
    const response = await get(`/c/${token(callId)}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      callId,
      startedAt: "2026-11-07T09:00:00.000Z",
      endedAt: "2026-11-07T09:02:00.000Z",
      durationSeconds: 120,
      callerNumber: "+447700900123",
      urgency: "urgent",
      summary: "Boiler leaking.",
      flags: ["mentioned leak"],
      fields: { callerName: "Sam", callbackNumber: "+447700900123", postcode: "XQ12 3JL" },
      transcript: [
        { role: "agent", text: "Hi, how can I help?" },
        { role: "caller", text: "My boiler is leaking." },
      ],
      viaFallback: false,
      recording: { available: true, url: `/c/${token(callId)}/recording` },
    });
    expect(JSON.stringify(body)).not.toContain("twilio");
  });

  it("answers 410 for an expired link and 404 for a forged or malformed one", async () => {
    const { callId } = await makeCall("agent");
    const expired = token(callId, new Date(NOW.getTime() - 1000));
    expect((await get(`/c/${expired}`)).status).toBe(410);

    const good = token(callId);
    const forged = good.slice(0, -1) + (good.endsWith("A") ? "B" : "A");
    expect((await get(`/c/${forged}`)).status).toBe(404);
    expect((await get(`/c/not-a-token`)).status).toBe(404);
  });

  it("answers 404 for a valid link to a call that doesn't exist", async () => {
    expect((await get(`/c/${token(randomUUID())}`)).status).toBe(404);
  });
});

describe("GET /c/:token from a browser: the page a person opens from a text", () => {
  it("shows the call as a page: who, how urgent, the number to ring, summary, recording, transcript", async () => {
    const { callId } = await makeCall("agent");
    const response = await getPage(`/c/${token(callId)}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("vary")).toContain("Accept");
    // No script may load or run, whatever the page holds.
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("script-src");
    const html = await response.text();
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).toContain('<span class="badge urgent">URGENT</span>');
    expect(html).toContain('<span class="badge">mentioned leak</span>');
    expect(html).toContain("<h1>Sam</h1>");
    expect(html).toContain("Saturday 7 November 2026, 09:00 · 2 min");
    expect(html).toContain('<a class="button" href="tel:+447700900123">Call back 07700 900123</a>');
    expect(html).toContain("<dd>XQ12 3JL</dd>");
    expect(html).toContain("Boiler leaking.");
    expect(html).toContain(`<audio controls preload="none" src="/c/${token(callId)}/recording">`);
    expect(html).toContain("<strong>Assistant:</strong> Hi, how can I help?");
    expect(html).toContain("<strong>Caller:</strong> My boiler is leaking.");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("twilio");
  });

  it("shows what a caller said as text, never as page code", async () => {
    const tenantId = await createTenant(admin, { businessName: "Page Plumbing", trade: "plumber" });
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO calls (tenant_id, provider_call_id, caller_number, started_at, ended_at,
                          billable_seconds, transcript, summary, urgency, extracted_fields)
       VALUES ($1, $2, NULL, '2026-11-07T09:00:00Z', '2026-11-07T09:00:30Z', 30,
               E'caller: <script>alert(1)</script>', '<img src=x onerror=alert(2)>', 'routine',
               '{"callerName":"<b>Sam</b>","postcode":"\\"><svg onload=alert(3)>"}')
       RETURNING id`,
      [tenantId, `call_${randomUUID()}`],
    );
    const html = await (await getPage(`/c/${token(rows[0]!.id)}`)).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(2)&gt;");
    expect(html).toContain("<h1>&lt;b&gt;Sam&lt;/b&gt;</h1>");
    expect(html).not.toContain("<svg");
    // A withheld number: no button to ring.
    expect(html).toContain("Their number was withheld.");
    expect(html).not.toContain('href="tel:');
  });

  it("shows a voicemail with its recording, and says there's no transcript", async () => {
    const { callId } = await makeCall("voicemail");
    const html = await (await getPage(`/c/${token(callId)}`)).text();
    expect(html).toContain("<h1>Unknown caller</h1>");
    expect(html).toContain("· voicemail");
    expect(html).toContain("A voicemail: listen to it below.");
    expect(html).toContain("<audio controls");
    expect(html).toContain("No transcript for this call.");
  });

  it("says so in a page when the link has expired, and points to the dashboard", async () => {
    const { callId } = await makeCall("agent");
    const response = await getPage(`/c/${token(callId, new Date(NOW.getTime() - 1000))}`);
    expect(response.status).toBe(410);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("<h1>This link has expired</h1>");
    expect(html).toContain('href="https://app.example.com"');
    expect(html).not.toContain("Sam");
  });

  it("says so in a page when the link doesn't match a call", async () => {
    for (const path of [`/c/not-a-token`, `/c/${token(randomUUID())}`]) {
      const response = await getPage(path);
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).toContain("<h1>Call not found</h1>");
    }
  });
});

describe("GET /c/:token/recording", () => {
  it("streams a voicemail's audio through the API", async () => {
    const { callId, recordingUrl } = await makeCall("voicemail");
    telephony.recordingAudio.set(recordingUrl, new Uint8Array([0x49, 0x44, 0x33, 0x04]));
    const page = (await (await get(`/c/${token(callId)}`)).json()) as {
      recording: { available: boolean };
    };
    expect(page.recording.available).toBe(true);

    const response = await get(`/c/${token(callId)}/recording`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("audio/mpeg");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([0x49, 0x44, 0x33, 0x04]),
    );
  });

  it("answers 404 when the provider no longer has the recording", async () => {
    const { callId } = await makeCall("voicemail");
    expect((await get(`/c/${token(callId)}/recording`)).status).toBe(404);
  });

  it("streams an agent call's recording from the voice platform, by provider call ID", async () => {
    const { callId, providerCallId } = await makeCall("agent");
    voice.recordingAudio.set(providerCallId, new Uint8Array([0x52, 0x49, 0x46, 0x46]));
    const response = await get(`/c/${token(callId)}/recording`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("audio/wav");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([0x52, 0x49, 0x46, 0x46]),
    );
  });

  it("never serves a recording as anything but audio, whatever the platform claims", async () => {
    const { callId, providerCallId } = await makeCall("agent");
    voice.recordingAudio.set(providerCallId, new Uint8Array([0x3c, 0x68, 0x31, 0x3e]));
    voice.recordingContentType = "text/html";
    try {
      const response = await get(`/c/${token(callId)}/recording`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/octet-stream");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    } finally {
      voice.recordingContentType = "audio/wav";
    }
  });

  it("reports no recording for a call that was never recorded", async () => {
    const { callId } = await makeCall("agent", { recorded: false });
    const page = (await (await get(`/c/${token(callId)}`)).json()) as {
      recording: { available: boolean };
    };
    expect(page.recording.available).toBe(false);
    expect((await get(`/c/${token(callId)}/recording`)).status).toBe(404);
  });

  it("checks the link like the page does", async () => {
    const { callId } = await makeCall("voicemail");
    expect((await get(`/c/${token(callId, new Date(NOW.getTime() - 1))}/recording`)).status).toBe(
      410,
    );
  });
});

describe("GET /c/:token/recording when the provider drops the stream", () => {
  it("ends the response without taking the API down", async () => {
    const { callId, recordingUrl } = await makeCall("voicemail");
    telephony.brokenRecordings.add(recordingUrl);
    try {
      const response = await get(`/c/${token(callId)}/recording`);
      await response.arrayBuffer();
    } catch {
      // The connection being cut short is the expected outcome.
    }
    // The server is still answering.
    const { callId: other } = await makeCall("agent");
    expect((await get(`/c/${token(other)}`)).status).toBe(200);
  });
});
