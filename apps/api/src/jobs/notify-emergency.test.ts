import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseAllowlist } from "../core/outbound-allowlist.ts";
import { gasScript } from "../core/scripts.ts";
import { isGsm7 } from "../core/sms.ts";
import { createAdminPool, createTenant } from "../db/cross-tenant.ts";
import { createPool } from "../db/pool.ts";
import { withTenant } from "../db/tenant.ts";
import { FakeSmsProvider } from "../providers/sms.fake.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import {
  gasScriptSpoken,
  runNotifyEmergency,
  type NotifyEmergencyDeps,
} from "./notify-emergency.ts";

const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);

afterAll(async () => {
  await Promise.all([app.end(), admin.end()]);
});

const MOBILE = "+447700900001";
const CALLER = "+447700900123";
const GAS_TRANSCRIPT = `agent: Hi, you're through to Gas Plumbing. How can I help?
caller: I can smell gas in the kitchen.
agent: ${gasScript("Sam", "GB")}
caller: OK, thanks.`;

type TestDeps = NotifyEmergencyDeps & { sms: FakeSmsProvider };

function deps(overrides: Partial<Omit<NotifyEmergencyDeps, "sms">> = {}): TestDeps {
  return {
    pool: app,
    sms: new FakeSmsProvider(),
    outbound: { nodeEnv: "test", allowlist: parseAllowlist(`${MOBILE}, ${CALLER}`) },
    alert: vi.fn(),
    ...overrides,
  };
}

async function makeCall(
  overrides: {
    urgency?: string;
    caller?: string | null;
    transcript?: string;
    mobile?: string | null;
    region?: "GB" | "NI";
  } = {},
) {
  const tenantId = await createTenant(admin, {
    businessName: "Gas Plumbing",
    trade: "plumber",
    ...(overrides.mobile !== null && { notificationMobile: overrides.mobile ?? MOBILE }),
    ...(overrides.region && { serviceRegion: overrides.region }),
  });
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO calls (tenant_id, provider_call_id, caller_number, started_at, ended_at,
                        transcript, summary, urgency, extracted_fields)
     VALUES ($1, $2, $3, now() - interval '3 minutes', now(), $4, 'Gas smell in the kitchen.', $5, '{}')
     RETURNING id`,
    [
      tenantId,
      `call_${randomUUID()}`,
      overrides.caller === undefined ? CALLER : overrides.caller,
      overrides.transcript ?? GAS_TRANSCRIPT,
      overrides.urgency ?? "emergency",
    ],
  );
  return { tenantId, callId: rows[0]!.id };
}

const notifications = (tenantId: string, callId: string) =>
  withTenant(
    app,
    tenantId,
    async (client) =>
      (
        await client.query<{ channel: string; status: string }>(
          "SELECT channel, status FROM notifications WHERE call_id = $1 ORDER BY channel",
          [callId],
        )
      ).rows,
  );

describe("runNotifyEmergency", () => {
  it("texts the tradesperson first and the caller the gas number", async () => {
    const { tenantId, callId } = await makeCall();
    const d = deps();
    expect(await runNotifyEmergency(d, { tenantId, callId })).toEqual({
      tradesperson: "sent",
      caller: "sent",
    });
    expect(d.sms.sent.map((s) => s.to)).toEqual([MOBILE, CALLER]);
    const [toTradesperson, toCaller] = d.sms.sent;
    expect(toTradesperson!.body).toMatch(/^EMERGENCY/);
    expect(toTradesperson!.body).toContain("tel:+447700900123");
    expect(toCaller!.body).toContain("0800 111 999");
    expect(toCaller!.body).toContain("Gas Plumbing");
    for (const text of d.sms.sent) {
      expect(isGsm7(text.body)).toBe(true);
      expect(text.segments).toBe(1);
    }
    expect(await notifications(tenantId, callId)).toEqual([
      { channel: "sms_caller", status: "sent" },
      { channel: "sms_emergency", status: "sent" },
    ]);
  });

  it("gives Northern Ireland callers their own gas number", async () => {
    const { tenantId, callId } = await makeCall({ region: "NI" });
    const d = deps();
    await runNotifyEmergency(d, { tenantId, callId });
    expect(d.sms.sent[1]!.body).toContain("0800 002 001");
  });

  it("never sends either text twice", async () => {
    const { tenantId, callId } = await makeCall();
    const d = deps();
    await runNotifyEmergency(d, { tenantId, callId });
    expect(await runNotifyEmergency(d, { tenantId, callId })).toEqual({
      tradesperson: "already-sent",
      caller: "already-sent",
    });
    expect(d.sms.sent).toHaveLength(2);
  });

  it("does nothing for a call that isn't an emergency", async () => {
    const { tenantId, callId } = await makeCall({ urgency: "urgent" });
    const d = deps();
    expect(await runNotifyEmergency(d, { tenantId, callId })).toBe("not-emergency");
    expect(d.sms.sent).toHaveLength(0);
  });

  it("texts only the tradesperson when the gas script wasn't spoken (a fire, say)", async () => {
    const { tenantId, callId } = await makeCall({
      transcript:
        "agent: Hi.\ncaller: There are sparks coming from the fuse box.\nagent: If anyone is in danger, or there's a fire or smoke, please hang up now and call 999.",
    });
    const d = deps();
    expect(await runNotifyEmergency(d, { tenantId, callId })).toEqual({
      tradesperson: "sent",
      caller: "not-gas",
    });
    expect(d.sms.sent).toHaveLength(1);
  });

  it("can't text a caller who withheld their number, but still tells the tradesperson", async () => {
    const { tenantId, callId } = await makeCall({ caller: null });
    const d = deps();
    expect(await runNotifyEmergency(d, { tenantId, callId })).toEqual({
      tradesperson: "sent",
      caller: "no-number",
    });
    expect(d.sms.sent[0]!.body).toContain("number was withheld");
  });

  it("blocks a caller who isn't on the allowlist outside production", async () => {
    const { tenantId, callId } = await makeCall({ caller: "+447700900999" });
    const d = deps();
    expect(await runNotifyEmergency(d, { tenantId, callId })).toEqual({
      tradesperson: "sent",
      caller: "blocked",
    });
    expect(d.sms.sent.map((s) => s.to)).toEqual([MOBILE]);
  });

  it("alerts when the tenant has no mobile and still texts the caller", async () => {
    const { tenantId, callId } = await makeCall({ mobile: null });
    const d = deps();
    expect(await runNotifyEmergency(d, { tenantId, callId })).toEqual({
      tradesperson: "no-mobile",
      caller: "sent",
    });
    expect(d.alert).toHaveBeenCalledWith("notification-no-mobile", { tenantId, callId });
  });
});

describe("gasScriptSpoken", () => {
  it("only counts the agent saying it", () => {
    expect(gasScriptSpoken(GAS_TRANSCRIPT)).toBe(true);
    expect(gasScriptSpoken("caller: should I ring the National Gas Emergency Service?")).toBe(
      false,
    );
    expect(gasScriptSpoken(null)).toBe(false);
  });
});

describe("runNotifyEmergency mid-call", () => {
  it("texts the caller the gas number on the function's say-so, before there is any transcript", async () => {
    const { tenantId, callId } = await makeCall({ transcript: "" });
    await admin.query(
      "UPDATE calls SET transcript = NULL, summary = NULL, ended_at = NULL WHERE id = $1",
      [callId],
    );
    const d = deps();
    expect(await runNotifyEmergency(d, { tenantId, callId, kind: "gas" })).toEqual({
      tradesperson: "sent",
      caller: "sent",
    });
    expect(d.sms.sent[1]!.body).toContain("0800 111 999");
  });

  it("alerts only the tradesperson for a danger alert", async () => {
    const { tenantId, callId } = await makeCall({ transcript: "" });
    const d = deps();
    expect(await runNotifyEmergency(d, { tenantId, callId, kind: "danger" })).toEqual({
      tradesperson: "sent",
      caller: "not-gas",
    });
  });
});
