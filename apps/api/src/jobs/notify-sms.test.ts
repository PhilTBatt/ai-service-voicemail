import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseAllowlist } from "../core/outbound-allowlist.ts";
import { verifyCallLink } from "../core/signed-links.ts";
import { isGsm7 } from "../core/sms.ts";
import { createAdminPool, createTenant } from "../db/cross-tenant.ts";
import { createPool } from "../db/pool.ts";
import { withTenant } from "../db/tenant.ts";
import { FakeSmsProvider } from "../providers/sms.fake.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import { runNotifySms, type NotifySmsDeps } from "./notify-sms.ts";

const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);

afterAll(async () => {
  await Promise.all([app.end(), admin.end()]);
});

const MOBILE = "+447700900001";
const SECRET = "test-signing-secret-at-least-32-characters-long";

type TestDeps = NotifySmsDeps & { sms: FakeSmsProvider };

function deps(overrides: Partial<Omit<NotifySmsDeps, "sms">> = {}): TestDeps {
  return {
    pool: app,
    sms: new FakeSmsProvider(),
    outbound: { nodeEnv: "test", allowlist: parseAllowlist(MOBILE) },
    signingSecret: SECRET,
    publicBaseUrl: "https://callmate.example.com",
    alert: vi.fn(),
    ...overrides,
  };
}

/** A tenant with one processed call. */
async function makeProcessedCall(
  overrides: {
    mobile?: string | null;
    fields?: Record<string, unknown>;
    summary?: string | null;
  } = {},
) {
  const tenantId = await createTenant(admin, {
    businessName: "Notify Plumbing",
    trade: "plumber",
    ...(overrides.mobile !== null && { notificationMobile: overrides.mobile ?? MOBILE }),
  });
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO calls (tenant_id, provider_call_id, caller_number, started_at, ended_at,
                        summary, urgency, extracted_fields)
     VALUES ($1, $2, '+447700900123', now() - interval '2 minutes', now(), $3, 'urgent', $4)
     RETURNING id`,
    [
      tenantId,
      `call_${randomUUID()}`,
      overrides.summary === undefined
        ? "Boiler leaking under the sink.\nNo hot water."
        : overrides.summary,
      JSON.stringify(
        overrides.fields ?? {
          callerName: "Sam",
          callbackNumber: "+447700900123",
          postcode: "XQ12 3JL",
        },
      ),
    ],
  );
  return { tenantId, callId: rows[0]!.id };
}

const rows = (tenantId: string, callId: string) =>
  withTenant(app, tenantId, async (client) => ({
    notifications: (
      await client.query(
        "SELECT channel, status, attempts, provider_ref FROM notifications WHERE call_id = $1",
        [callId],
      )
    ).rows,
    costs: (
      await client.query(
        "SELECT component, units, unit_type, is_estimated FROM call_costs WHERE call_id = $1",
        [callId],
      )
    ).rows,
  }));

describe("runNotifySms", () => {
  it("texts the tradesperson's mobile and records the notification, cost and a valid link", async () => {
    const { tenantId, callId } = await makeProcessedCall();
    const d = deps();
    expect(await runNotifySms(d, { tenantId, callId })).toBe("sent");

    expect(d.sms.sent).toHaveLength(1);
    const text = d.sms.sent[0]!;
    expect(text.to).toBe(MOBILE);
    expect(isGsm7(text.body)).toBe(true);
    const lines = text.body.split("\n");
    expect(lines.slice(0, 3)).toEqual([
      "URGENT: Sam, 07700 900123, XQ12 3JL",
      "Boiler leaking under the sink. No hot water.",
      "Call back: tel:+447700900123",
    ]);
    const link = /^Details: https:\/\/callmate\.example\.com\/c\/(\S+)$/.exec(lines[3] ?? "");
    expect(verifyCallLink(link?.[1] ?? "", SECRET)).toEqual({ ok: true, callId });
    expect(text.segments).toBeLessThanOrEqual(2); // the real text with a link is two segments

    expect(await rows(tenantId, callId)).toEqual({
      notifications: [
        { channel: "sms", status: "sent", attempts: 1, provider_ref: text.providerRef },
      ],
      costs: [
        {
          component: "sms:segments",
          units: `${text.segments}.0000`,
          unit_type: "segments",
          is_estimated: false,
        },
      ],
    });
  });

  it("falls back to the caller ID when the caller didn't give a number", async () => {
    const { tenantId, callId } = await makeProcessedCall({
      fields: { callerName: null, callbackNumber: null },
    });
    const d = deps();
    await runNotifySms(d, { tenantId, callId });
    expect(d.sms.sent[0]?.body).toContain("tel:+447700900123");
  });

  it("sends nothing and records 'blocked' when the mobile isn't on the allowlist", async () => {
    const { tenantId, callId } = await makeProcessedCall({ mobile: "+447700900999" });
    const d = deps();
    expect(await runNotifySms(d, { tenantId, callId })).toBe("blocked");
    expect(d.sms.sent).toHaveLength(0);
    expect((await rows(tenantId, callId)).notifications).toEqual([
      { channel: "sms", status: "blocked", attempts: 1, provider_ref: null },
    ]);
    // Idempotent: a retry doesn't send either.
    expect(await runNotifySms(d, { tenantId, callId })).toBe("blocked");
  });

  it("sends everything in production", async () => {
    const { tenantId, callId } = await makeProcessedCall({ mobile: "+447700900999" });
    const d = deps({ outbound: { nodeEnv: "production", allowlist: new Set() } });
    expect(await runNotifySms(d, { tenantId, callId })).toBe("sent");
  });

  it("never sends the same text twice", async () => {
    const { tenantId, callId } = await makeProcessedCall();
    const d = deps();
    await runNotifySms(d, { tenantId, callId });
    expect(await runNotifySms(d, { tenantId, callId })).toBe("already-sent");
    expect(d.sms.sent).toHaveLength(1);
  });

  it("marks a failed send and lets the queue retry it", async () => {
    const { tenantId, callId } = await makeProcessedCall();
    const d = deps();
    d.sms.willFail("Twilio down");
    await expect(runNotifySms(d, { tenantId, callId })).rejects.toThrow("Twilio down");
    expect((await rows(tenantId, callId)).notifications).toEqual([
      { channel: "sms", status: "failed", attempts: 1, provider_ref: null },
    ]);
    // The reason is kept for the admin's health screen, redacted like a log line would be.
    const reason = await withTenant(
      app,
      tenantId,
      async (client) =>
        (
          await client.query<{ failure_reason: string | null }>(
            "SELECT failure_reason FROM notifications WHERE call_id = $1",
            [callId],
          )
        ).rows[0]?.failure_reason,
    );
    expect(reason).toBe("Error: Twilio down");
    expect(await runNotifySms(d, { tenantId, callId })).toBe("sent");
    expect((await rows(tenantId, callId)).notifications[0]).toMatchObject({
      status: "sent",
      attempts: 2,
    });
  });

  // Phil's first live call (2026-11-10) retried an invalid number six times over twenty
  // minutes; nobody could have been told sooner.
  it("ends the job and alerts at once when the provider refuses the number for good", async () => {
    const { tenantId, callId } = await makeProcessedCall();
    const d = deps();
    d.sms.willFail(
      Object.assign(new Error("Twilio /Messages.json failed: HTTP 400 invalid To"), {
        status: 400,
      }),
    );
    expect(await runNotifySms(d, { tenantId, callId })).toBe("refused");
    expect((await rows(tenantId, callId)).notifications).toEqual([
      { channel: "sms", status: "failed", attempts: 1, provider_ref: null },
    ]);
    expect(d.alert).toHaveBeenCalledWith("notification-refused", {
      tenantId,
      callId,
      channel: "sms",
      reason: "Error: Twilio /Messages.json failed: HTTP 400 invalid To",
    });
    expect(d.sms.sent).toHaveLength(0);

    // Being told to slow down is not a refusal: that one is retried as before.
    d.sms.willFail(Object.assign(new Error("Twilio: HTTP 429 too many requests"), { status: 429 }));
    await expect(runNotifySms(d, { tenantId, callId })).rejects.toThrow("429");
  });

  it("alerts when the tenant has no notification mobile", async () => {
    const { tenantId, callId } = await makeProcessedCall({ mobile: null });
    const d = deps();
    expect(await runNotifySms(d, { tenantId, callId })).toBe("no-mobile");
    expect(d.alert).toHaveBeenCalledWith("notification-no-mobile", { tenantId, callId });
    expect(d.sms.sent).toHaveLength(0);
  });

  it("fails (so the queue retries) if the call hasn't been processed yet", async () => {
    const { tenantId, callId } = await makeProcessedCall({ summary: null });
    await expect(runNotifySms(deps(), { tenantId, callId })).rejects.toThrow(
      "has not been processed",
    );
  });
});

describe("runNotifySms for a fallback voicemail", () => {
  it("texts a 'new voicemail' message with a link, without needing a summary", async () => {
    const tenantId = await createTenant(admin, {
      businessName: "Voicemail Plumbing",
      trade: "plumber",
      notificationMobile: MOBILE,
    });
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO calls (tenant_id, provider_call_id, caller_number, started_at, ended_at,
                          billable_seconds, outcome, recording_ref, via_fallback, extracted_fields)
       VALUES ($1, $2, '+447700900123', now() - interval '2 minutes', now(), 0, 'voicemail',
               'https://api.twilio.com/2010-04-01/Accounts/AC0/Recordings/RE1', true,
               '{"recordingSeconds": 42}')
       RETURNING id`,
      [tenantId, `CA${randomUUID().replace(/-/g, "")}`],
    );
    const callId = rows[0]!.id;
    const d = deps();
    expect(await runNotifySms(d, { tenantId, callId })).toBe("sent");
    const body = d.sms.sent[0]!.body;
    expect(body).toMatch(/^New voicemail \(42 sec\) from 07700 900123\./);
    expect(body).toContain("Call back: tel:+447700900123");
    expect(body).toContain("Listen: https://callmate.example.com/c/");
    expect(body).not.toContain("api.twilio.com"); // provider URLs are never exposed
  });
});

describe("runNotifySms for a transcribed voicemail", () => {
  // Decision 022: once the voicemail's transcript has been summarised, the text carries the
  // summary like a call's, and says it was a voicemail.
  it("texts the summary, marked as a voicemail, with the call link", async () => {
    const tenantId = await createTenant(admin, {
      businessName: "Voicemail Plumbing",
      trade: "plumber",
      notificationMobile: MOBILE,
    });
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO calls (tenant_id, provider_call_id, caller_number, started_at, ended_at,
                          billable_seconds, outcome, recording_ref, via_fallback, transcript,
                          summary, urgency, extracted_fields)
       VALUES ($1, $2, '+447700900123', now() - interval '2 minutes', now(), 0, 'voicemail',
               'https://api.twilio.com/2010-04-01/Accounts/AC0/Recordings/RE1', true,
               'caller: It''s Sam, no hot water since this morning.',
               'No hot water since this morning.', 'urgent',
               '{"recordingSeconds": 42, "callerName": "Sam", "callbackNumber": "+447700900123", "postcode": "XQ12 3JL"}')
       RETURNING id`,
      [tenantId, `CA${randomUUID().replace(/-/g, "")}`],
    );
    const callId = rows[0]!.id;
    const d = deps();
    expect(await runNotifySms(d, { tenantId, callId })).toBe("sent");
    const body = d.sms.sent[0]!.body;
    expect(body).toMatch(/^URGENT \(voicemail\): Sam, 07700 900123, XQ12 3JL\n/);
    expect(body).toContain("No hot water since this morning.");
    expect(body).toContain("Details: https://callmate.example.com/c/");
    expect(body).not.toContain("New voicemail");
  });
});

describe("runNotifySms after a delivery receipt", () => {
  it("never resends a text the carrier already reported on, delivered or not", async () => {
    const { tenantId, callId } = await makeProcessedCall();
    const d = deps();
    await runNotifySms(d, { tenantId, callId });
    for (const status of ["delivered", "undelivered"]) {
      await admin.query("UPDATE notifications SET status = $2 WHERE call_id = $1", [
        callId,
        status,
      ]);
      expect(await runNotifySms(d, { tenantId, callId })).toBe("already-sent");
    }
    expect(d.sms.sent).toHaveLength(1);
  });
});
