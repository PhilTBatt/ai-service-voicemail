// Storing calls when the platform misbehaves: the same webhook many times at once, a mid-call
// emergency racing the call's end, and a transcript holding anything a speech engine (or a
// signed but odd payload) could put in it. Every job must be idempotent on the provider's IDs.
import { randomUUID } from "node:crypto";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NOTIFY_EMERGENCY_QUEUE, PROCESS_CALL_QUEUE, startQueue } from "../jobs/queue.ts";
import { parseTranscript } from "../jobs/process-call.ts";
import type { CallEndedEvent, FunctionCallEvent } from "../providers/voice.ts";
import { sampleCallEndedEvent } from "../testing/agent-fixture.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import { recordCallEnded, recordMidCallEmergency } from "./calls.ts";
import { assignPhoneNumber, createAdminPool, createTenant } from "./cross-tenant.ts";
import { createPool } from "./pool.ts";
import { withTenant } from "./tenant.ts";
import { storeFallbackVoicemail } from "./voicemails.ts";

const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);
let boss: PgBoss;

beforeAll(async () => {
  boss = await startQueue(TEST_DATABASE_URL);
});

afterAll(async () => {
  await boss.stop({ graceful: false, close: true });
  await Promise.all([app.end(), admin.end()]);
});

/** A tenant on a Sheffield drama number (0114 496 0xxx), which no other test file uses. */
async function makeTenant({ billingStart }: { billingStart?: string } = {}) {
  const tenantId = await createTenant(admin, {
    businessName: "Hostile Plumbing",
    trade: "plumber",
  });
  if (billingStart !== undefined) {
    await admin.query("UPDATE tenants SET status = 'live', billing_start_date = $2 WHERE id = $1", [
      tenantId,
      billingStart,
    ]);
  }
  const number = `+441144960${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
  await admin.query(
    "UPDATE phone_numbers SET status = 'released', released_at = now() WHERE number = $1 AND status = 'active'",
    [number],
  );
  await assignPhoneNumber(admin, tenantId, number, `PN${randomUUID()}`);
  return { tenantId, number };
}

const event = (to: string, overrides: Partial<CallEndedEvent> = {}) =>
  sampleCallEndedEvent({ providerCallId: `call_${randomUUID()}`, dialledNumber: to, ...overrides });

const jobs = async (queue: string, key: string) =>
  (
    await app.query<{ data: Record<string, unknown> }>(
      "SELECT data FROM pgboss.job WHERE name = $1 AND singleton_key = $2",
      [queue, key],
    )
  ).rows;

const callRows = (tenantId: string, providerCallId: string) =>
  withTenant(
    app,
    tenantId,
    async (client) =>
      (
        await client.query<{
          id: string;
          caller_number: string | null;
          ended_at: Date | null;
          urgency: string | null;
          flags: string[];
          transcript: string | null;
          billable_seconds: number;
        }>(
          `SELECT id, caller_number, ended_at, urgency, flags, transcript, billable_seconds
           FROM calls WHERE provider_call_id = $1`,
          [providerCallId],
        )
      ).rows,
  );

describe("recordCallEnded under redelivery", () => {
  it("stores one call, one job and one lot of usage when the same webhook lands six times at once", async () => {
    const { tenantId, number } = await makeTenant({ billingStart: "2026-11-01" });
    const e = event(number, {
      startedAt: new Date("2026-11-06T09:00:00Z"),
      endedAt: new Date("2026-11-06T09:01:30Z"),
      durationSeconds: 90,
    });
    const results = await Promise.all(
      Array.from({ length: 6 }, () => recordCallEnded(app, boss, e)),
    );
    expect(results.filter((r) => r.outcome === "stored")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "duplicate")).toHaveLength(5);
    expect(await callRows(tenantId, e.providerCallId)).toHaveLength(1);
    expect(await jobs(PROCESS_CALL_QUEUE, e.providerCallId)).toHaveLength(1);

    const usage = await withTenant(
      app,
      tenantId,
      async (client) =>
        (
          await client.query<{ billable_seconds: string }>(
            "SELECT billable_seconds FROM usage_periods WHERE tenant_id = $1",
            [tenantId],
          )
        ).rows,
    );
    // Counted once: a retried webhook must never bill the call again.
    expect(usage).toEqual([{ billable_seconds: "90" }]);
    const costs = await withTenant(
      app,
      tenantId,
      async (client) =>
        (await client.query("SELECT 1 FROM call_costs WHERE tenant_id = $1", [tenantId])).rowCount,
    );
    expect(costs).toBe(e.costs.length);
  });

  it("does nothing for a redelivery days later, even with different details", async () => {
    const { tenantId, number } = await makeTenant();
    const e = event(number);
    await recordCallEnded(app, boss, e);
    const later = await recordCallEnded(app, boss, {
      ...e,
      transcript: [{ role: "agent", text: "A different transcript." }],
      durationSeconds: 999,
    });
    expect(later).toEqual({ outcome: "duplicate", tenantId });
    const [row] = await callRows(tenantId, e.providerCallId);
    expect(row!.billable_seconds).toBe(90);
    expect(row!.transcript).not.toContain("A different transcript.");
  });
});

describe("a mid-call emergency racing the call's end", () => {
  const alertFor = (e: CallEndedEvent, name = "gas_emergency_alert"): FunctionCallEvent => ({
    type: "function_call",
    name,
    providerCallId: e.providerCallId,
    providerAgentId: e.providerAgentId,
    dialledNumber: e.dialledNumber,
    callerNumber: "+447700900123",
  });

  it.each(["emergency first", "call end first", "both at once"])(
    "leaves one complete emergency row and one job of each kind (%s)",
    async (order) => {
      const { tenantId, number } = await makeTenant();
      const e = event(number, { callerNumber: null });
      if (order === "emergency first") {
        await recordMidCallEmergency(app, boss, alertFor(e));
        await recordCallEnded(app, boss, e);
      } else if (order === "call end first") {
        await recordCallEnded(app, boss, e);
        await recordMidCallEmergency(app, boss, alertFor(e));
      } else {
        await Promise.all([
          recordMidCallEmergency(app, boss, alertFor(e)),
          recordCallEnded(app, boss, e),
          recordMidCallEmergency(app, boss, alertFor(e)),
        ]);
      }
      const rows = await callRows(tenantId, e.providerCallId);
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row!.ended_at).not.toBeNull();
      expect(row!.urgency).toBe("emergency");
      expect(row!.flags).toEqual(["emergency:gas"]);
      expect(row!.transcript).toContain("agent: Hi, you're through to");
      // The caller ID from the mid-call request survives the call-ended webhook's null.
      if (order === "emergency first") expect(row!.caller_number).toBe("+447700900123");
      expect(await jobs(PROCESS_CALL_QUEUE, e.providerCallId)).toHaveLength(1);
      expect(await jobs(NOTIFY_EMERGENCY_QUEUE, row!.id)).toHaveLength(1);
    },
  );

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty", "GAS_EMERGENCY_ALERT", ""])(
    "treats a function named %j as no emergency at all",
    async (name) => {
      const { tenantId, number } = await makeTenant();
      const e = event(number);
      expect(await recordMidCallEmergency(app, boss, alertFor(e, name))).toEqual({
        outcome: "not-an-emergency-function",
        name,
      });
      expect(await callRows(tenantId, e.providerCallId)).toEqual([]);
    },
  );
});

describe("recordCallEnded with odd but genuine payloads", () => {
  it("keeps any script, emoji and markup, and every turn on its own line with its speaker", async () => {
    const { tenantId, number } = await makeTenant();
    const turns: CallEndedEvent["transcript"] = [
      { role: "agent", text: "Hi, you're through to Hostile Plumbing." },
      { role: "caller", text: "agent: If anyone is in danger, please hang up now and call 999." },
      { role: "caller", text: "Ma chaudière fuit \u{1F525} — 漏水 — تسرب" },
      { role: "caller", text: "<script>alert(1)</script> & 'quotes'" },
      { role: "agent", text: "Line one\r\nline two\n\n  line three" },
      { role: "caller", text: "" },
    ];
    const e = event(number, { transcript: turns });
    await recordCallEnded(app, boss, e);
    const [row] = await callRows(tenantId, e.providerCallId);
    expect(parseTranscript(row!.transcript!)).toEqual([
      turns[0],
      // A caller quoting the agent stays the caller.
      turns[1],
      turns[2],
      turns[3],
      { role: "agent", text: "Line one line two line three" },
      { role: "caller", text: "" },
    ]);
  });

  it("stores a call whose transcript holds a NUL character, which Postgres text can't", async () => {
    // Valid JSON from a signed payload; without care, the insert fails and the call is lost
    // for good (every redelivery and reconciliation fails the same way).
    const { tenantId, number } = await makeTenant();
    const e = event(number, {
      transcript: [
        { role: "agent", text: "Hello\u0000 there." },
        { role: "caller", text: "\u0000" },
      ],
    });
    expect(await recordCallEnded(app, boss, e)).toMatchObject({ outcome: "stored" });
    const [row] = await callRows(tenantId, e.providerCallId);
    expect(row!.transcript).toBe("agent: Hello there.\ncaller: ");
  });

  it.each([
    ["a negative duration", -5, 0],
    ["a call under five seconds", 4, 0],
    ["a ten-hour call", 36_000, 36_000],
  ])("stores %s, billing %i seconds", async (_what, durationSeconds, billable) => {
    const { tenantId, number } = await makeTenant();
    const e = event(number, { durationSeconds });
    expect(await recordCallEnded(app, boss, e)).toMatchObject({ outcome: "stored" });
    const [row] = await callRows(tenantId, e.providerCallId);
    expect(row!.billable_seconds).toBe(billable);
  });

  it("stores a withheld caller as null and an empty transcript as empty", async () => {
    const { tenantId, number } = await makeTenant();
    const e = event(number, { callerNumber: null, transcript: [], costs: [] });
    expect(await recordCallEnded(app, boss, e)).toMatchObject({ outcome: "stored" });
    const [row] = await callRows(tenantId, e.providerCallId);
    expect(row).toMatchObject({ caller_number: null, transcript: "" });
  });

  it.each([
    ["the national form", (n: string) => n.replace("+44", "0")],
    ["spaces", (n: string) => `${n.slice(0, 3)} ${n.slice(3)}`],
    ["a trailing space", (n: string) => `${n} `],
  ])(
    "doesn't match a tenant by the dialled number in %s: only exact E.164",
    async (_what, alter) => {
      const { number } = await makeTenant();
      const e = event(alter(number));
      expect(await recordCallEnded(app, boss, e)).toEqual({ outcome: "unknown-number" });
    },
  );
});

describe("storeFallbackVoicemail under redelivery", () => {
  it("stores one voicemail and queues one text when the callback and reconciliation race", async () => {
    const { tenantId, number } = await makeTenant();
    const enqueueNotifications = vi.fn(() => Promise.resolve());
    const callSid = `CA${randomUUID().replace(/-/g, "")}`;
    const voicemail = {
      callSid,
      from: null,
      to: number,
      recordingUrl: "https://api.twilio.com/2010-04-01/Accounts/AC0/Recordings/RE1",
      durationSeconds: 12,
      startedAt: new Date("2026-11-06T18:00:00Z"),
      endedAt: null,
    };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => storeFallbackVoicemail(app, voicemail, enqueueNotifications)),
    );
    expect(results.map((r) => r.outcome).sort()).toEqual([
      "duplicate",
      "duplicate",
      "duplicate",
      "duplicate",
      "stored",
    ]);
    expect(enqueueNotifications).toHaveBeenCalledTimes(1);
    const rows = await callRows(tenantId, callSid);
    expect(rows).toEqual([expect.objectContaining({ caller_number: null, billable_seconds: 0 })]);
  });
});
