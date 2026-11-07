import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseAllowlist } from "../core/outbound-allowlist.ts";
import { verifyCallLink } from "../core/signed-links.ts";
import { createAdminPool, createTenant } from "../db/cross-tenant.ts";
import { createPool } from "../db/pool.ts";
import { withTenant } from "../db/tenant.ts";
import { FakeEmailProvider } from "../providers/email.fake.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import { runNotifyEmail, type NotifyEmailDeps } from "./notify-email.ts";

const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);

afterAll(async () => {
  await Promise.all([app.end(), admin.end()]);
});

const EMAIL = "sam@example.com";
const SECRET = "test-signing-secret-at-least-32-characters-long";

type TestDeps = NotifyEmailDeps & { email: FakeEmailProvider };

function deps(overrides: Partial<Omit<NotifyEmailDeps, "email">> = {}): TestDeps {
  return {
    pool: app,
    email: new FakeEmailProvider(),
    outbound: { nodeEnv: "test", allowlist: parseAllowlist(EMAIL) },
    signingSecret: SECRET,
    publicBaseUrl: "https://callmate.example.com",
    alert: vi.fn(),
    ...overrides,
  };
}

async function makeCall(
  kind: "agent" | "voicemail",
  overrides: { email?: string | null; recorded?: boolean } = {},
) {
  const tenantId = await createTenant(admin, {
    businessName: "Email Plumbing",
    trade: "plumber",
    ...(overrides.email !== null && { notificationEmail: overrides.email ?? EMAIL }),
  });
  const recordingRef = (overrides.recorded ?? true) ? "rec_ref_1" : null;
  const { rows } = await admin.query<{ id: string }>(
    kind === "agent"
      ? `INSERT INTO calls (tenant_id, provider_call_id, caller_number, started_at, ended_at,
                            billable_seconds, transcript, summary, urgency, flags, extracted_fields,
                            recording_ref)
         VALUES ($1, $2, '+447700900123', '2026-11-07T09:00:00Z', '2026-11-07T09:02:00Z', 120,
                 E'agent: Hi, how can I help?\\ncaller: My boiler is leaking & I smell gas.',
                 'Boiler leaking; caller smelt gas.', 'emergency', '{"mentioned gas smell"}',
                 '{"callerName":"Sam","callbackNumber":"+447700900123","postcode":"XQ12 3JL"}', $3)
         RETURNING id`
      : `INSERT INTO calls (tenant_id, provider_call_id, caller_number, started_at, ended_at,
                            billable_seconds, outcome, recording_ref, via_fallback)
         VALUES ($1, $2, '+447700900123', '2026-11-07T09:00:00Z', '2026-11-07T09:01:00Z', 42,
                 'voicemail', $3, true)
         RETURNING id`,
    [tenantId, `call_${randomUUID()}`, recordingRef],
  );
  return { tenantId, callId: rows[0]!.id };
}

const notificationRows = (tenantId: string, callId: string) =>
  withTenant(
    app,
    tenantId,
    async (client) =>
      (
        await client.query<{
          channel: string;
          status: string;
          attempts: number;
          provider_ref: string | null;
        }>("SELECT channel, status, attempts, provider_ref FROM notifications WHERE call_id = $1", [
          callId,
        ])
      ).rows,
  );

describe("runNotifyEmail", () => {
  it("emails the summary, details, transcript and links for an agent call", async () => {
    const { tenantId, callId } = await makeCall("agent");
    const d = deps();
    expect(await runNotifyEmail(d, { tenantId, callId })).toBe("sent");

    const [message] = d.email.sent;
    expect(message).toMatchObject({ to: EMAIL });
    expect(message!.subject).toBe(
      "EMERGENCY: Sam, 07700 900123 - Boiler leaking; caller smelt gas.",
    );
    expect(message!.text).toContain("Caller: Sam");
    expect(message!.text).toContain("Postcode: XQ12 3JL");
    expect(message!.text).toContain("Assistant: Hi, how can I help?");
    expect(message!.text).toContain("Caller: My boiler is leaking & I smell gas.");
    expect(message!.html).toContain("My boiler is leaking &amp; I smell gas."); // escaped
    expect(message!.html).not.toContain("<script");

    const link = /Call page: (\S+)/.exec(message!.text);
    const token = link![1]!.split("/c/")[1]!;
    expect(verifyCallLink(token, SECRET)).toEqual({ ok: true, callId });
    expect(message!.text).toContain(`Recording: https://callmate.example.com/c/${token}/recording`);

    expect(await notificationRows(tenantId, callId)).toEqual([
      { channel: "email", status: "sent", attempts: 1, provider_ref: message!.providerRef },
    ]);
  });

  it("leaves the recording line out when there is no recording", async () => {
    const { tenantId, callId } = await makeCall("agent", { recorded: false });
    const d = deps();
    await runNotifyEmail(d, { tenantId, callId });
    expect(d.email.sent[0]!.text).not.toContain("Recording:");
  });

  it("sends a 'new voicemail' email for a fallback voicemail", async () => {
    const { tenantId, callId } = await makeCall("voicemail");
    const d = deps();
    expect(await runNotifyEmail(d, { tenantId, callId })).toBe("sent");
    const [message] = d.email.sent;
    expect(message!.subject).toBe("New voicemail from 07700 900123 (42 sec)");
    expect(message!.text).toContain("Listen: https://callmate.example.com/c/");
    expect(message!.text).not.toContain("Transcript");
  });

  it("blocks an address that isn't on the allowlist outside production", async () => {
    const { tenantId, callId } = await makeCall("agent", { email: "someone@else.example" });
    const d = deps();
    expect(await runNotifyEmail(d, { tenantId, callId })).toBe("blocked");
    expect(d.email.sent).toHaveLength(0);
    expect((await notificationRows(tenantId, callId))[0]).toMatchObject({ status: "blocked" });
  });

  it("never sends the same email twice, and retries after a failure", async () => {
    const { tenantId, callId } = await makeCall("agent");
    const d = deps();
    d.email.willFail("provider down");
    await expect(runNotifyEmail(d, { tenantId, callId })).rejects.toThrow("provider down");
    expect((await notificationRows(tenantId, callId))[0]).toMatchObject({
      status: "failed",
      attempts: 1,
    });
    expect(await runNotifyEmail(d, { tenantId, callId })).toBe("sent");
    expect(await runNotifyEmail(d, { tenantId, callId })).toBe("already-sent");
    expect(d.email.sent).toHaveLength(1);
    expect((await notificationRows(tenantId, callId))[0]).toMatchObject({
      status: "sent",
      attempts: 2,
    });
  });

  it("alerts when the tenant has no email address", async () => {
    const { tenantId, callId } = await makeCall("agent", { email: null });
    const d = deps();
    expect(await runNotifyEmail(d, { tenantId, callId })).toBe("no-email");
    expect(d.alert).toHaveBeenCalledWith("notification-no-email", { tenantId, callId });
  });
});
