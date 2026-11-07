import { randomUUID } from "node:crypto";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NOTIFY_EMERGENCY_QUEUE, PROCESS_CALL_QUEUE, startQueue } from "../jobs/queue.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import { sampleCallEndedEvent } from "../testing/agent-fixture.ts";
import type { CallEndedEvent, FunctionCallEvent } from "../providers/voice.ts";
import { recordCallEnded, recordMidCallEmergency } from "./calls.ts";
import { assignPhoneNumber, createAdminPool, createTenant } from "./cross-tenant.ts";
import { createPool } from "./pool.ts";
import { withTenant } from "./tenant.ts";

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

async function makeTenant() {
  const tenantId = await createTenant(admin, { businessName: "Calls Plumbing", trade: "plumber" });
  const number = `+441514960${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
  await admin.query(
    "UPDATE phone_numbers SET status = 'released', released_at = now() WHERE number = $1 AND status = 'active'",
    [number],
  );
  await assignPhoneNumber(admin, tenantId, number, `PN${randomUUID()}`);
  return { tenantId, number };
}

const event = (to: string, overrides: Partial<CallEndedEvent> = {}) =>
  sampleCallEndedEvent({ providerCallId: `call_${randomUUID()}`, dialledNumber: to, ...overrides });

const jobsFor = async (providerCallId: string) =>
  (
    await app.query<{ state: string; data: unknown }>(
      "SELECT state, data FROM pgboss.job WHERE name = $1 AND singleton_key = $2",
      [PROCESS_CALL_QUEUE, providerCallId],
    )
  ).rows;

describe("recordCallEnded", () => {
  it("stores the call, its costs, and one process-call job", async () => {
    const { tenantId, number } = await makeTenant();
    const e = event(number);
    const result = await recordCallEnded(app, boss, e);
    expect(result).toMatchObject({ outcome: "stored", tenantId });
    if (result.outcome !== "stored") throw new Error("unreachable");

    const stored = await withTenant(app, tenantId, async (client) => {
      const call = (
        await client.query(
          "SELECT caller_number, outcome, transcript, recording_ref, billable_seconds FROM calls WHERE id = $1",
          [result.callId],
        )
      ).rows[0] as unknown;
      const costs = (
        await client.query(
          "SELECT component, units, unit_type, is_estimated FROM call_costs WHERE call_id = $1",
          [result.callId],
        )
      ).rows as unknown[];
      return { call, costs };
    });
    expect(stored.call).toEqual({
      caller_number: "+447700900123",
      outcome: "agent_hangup",
      transcript:
        "agent: Hi, you're through to Ant's Plumbing.\ncaller: My kitchen tap is dripping.",
      recording_ref: "rec_fixture_0001",
      billable_seconds: 90,
    });
    expect(stored.costs).toEqual([
      { component: "voice_minutes", units: "90.0000", unit_type: "seconds", is_estimated: false },
    ]);
    expect(await jobsFor(e.providerCallId)).toEqual([
      {
        state: "created",
        data: { tenantId, callId: result.callId, providerCallId: e.providerCallId },
      },
    ]);
  });

  it("adds billable seconds to the tenant's usage period, and bills nothing for a call under 5 s", async () => {
    const { tenantId, number } = await makeTenant();
    const july = new Date("2026-07-15T10:00:00Z");
    await recordCallEnded(app, boss, event(number, { durationSeconds: 90, startedAt: july }));
    await recordCallEnded(app, boss, event(number, { durationSeconds: 61, startedAt: july }));
    const short = await recordCallEnded(
      app,
      boss,
      event(number, { durationSeconds: 4.9, startedAt: july }),
    );
    if (short.outcome !== "stored") throw new Error("unreachable");

    const usage = await withTenant(
      app,
      tenantId,
      async (client) =>
        (
          await client.query<{
            period_start: string;
            period_end: string;
            billable_seconds: number;
          }>(
            "SELECT period_start::text, period_end::text, billable_seconds::int FROM usage_periods",
          )
        ).rows,
    );
    expect(usage).toEqual([
      { period_start: "2026-07-01", period_end: "2026-08-01", billable_seconds: 151 },
    ]);
    const shortRow = await withTenant(
      app,
      tenantId,
      async (client) =>
        (
          await client.query<{ billable_seconds: number }>(
            "SELECT billable_seconds FROM calls WHERE id = $1",
            [short.callId],
          )
        ).rows[0],
    );
    expect(shortRow).toEqual({ billable_seconds: 0 });
  });

  it("does nothing for a duplicate webhook: one row, one job", async () => {
    const { tenantId, number } = await makeTenant();
    const e = event(number);
    await recordCallEnded(app, boss, e);
    expect(await recordCallEnded(app, boss, e)).toEqual({ outcome: "duplicate", tenantId });
    const rows = await withTenant(
      app,
      tenantId,
      async (client) =>
        (await client.query("SELECT 1 FROM calls WHERE provider_call_id = $1", [e.providerCallId]))
          .rowCount,
    );
    expect(rows).toBe(1);
    expect(await jobsFor(e.providerCallId)).toHaveLength(1);
  });

  it("stores nothing for a number nobody owns", async () => {
    const e = event("+441632960999");
    expect(await recordCallEnded(app, boss, e)).toEqual({ outcome: "unknown-number" });
    expect(await jobsFor(e.providerCallId)).toEqual([]);
  });

  it("rolls the call row back if the job can't be queued (one transaction)", async () => {
    const { tenantId, number } = await makeTenant();
    const e = event(number);
    const brokenBoss = { send: () => Promise.reject(new Error("queue down")) } as unknown as PgBoss;
    await expect(recordCallEnded(app, brokenBoss, e)).rejects.toThrow("queue down");
    const rows = await withTenant(
      app,
      tenantId,
      async (client) =>
        (await client.query("SELECT 1 FROM calls WHERE provider_call_id = $1", [e.providerCallId]))
          .rowCount,
    );
    expect(rows).toBe(0);
  });
});

const functionCall = (to: string, name = "gas_emergency_alert"): FunctionCallEvent => ({
  type: "function_call",
  name,
  providerCallId: `call_${randomUUID()}`,
  providerAgentId: "fake_agent_1",
  dialledNumber: to,
  callerNumber: "+447700900123",
});

const emergencyJobsFor = async (callId: string) =>
  (
    await app.query<{ state: string; data: unknown; priority: number }>(
      "SELECT state, data, priority FROM pgboss.job WHERE name = $1 AND singleton_key = $2",
      [NOTIFY_EMERGENCY_QUEUE, callId],
    )
  ).rows;

const callRow = (tenantId: string, providerCallId: string) =>
  withTenant(
    app,
    tenantId,
    async (client) =>
      (
        await client.query(
          `SELECT count(*) OVER ()::int AS rows, urgency, flags, ended_at IS NOT NULL AS ended, transcript
           FROM calls WHERE provider_call_id = $1`,
          [providerCallId],
        )
      ).rows[0] as Record<string, unknown> | undefined,
  );

describe("recordMidCallEmergency", () => {
  it("opens a provisional row and queues the emergency texts; the call-ended webhook then completes the same row", async () => {
    const { tenantId, number } = await makeTenant();
    const fc = functionCall(number);
    const alerted = await recordMidCallEmergency(app, boss, fc);
    expect(alerted).toMatchObject({ outcome: "alerted", tenantId, kind: "gas" });
    if (alerted.outcome !== "alerted") throw new Error("unreachable");
    expect(await emergencyJobsFor(alerted.callId)).toEqual([
      { state: "created", data: { tenantId, callId: alerted.callId, kind: "gas" }, priority: 10 },
    ]);
    expect(await callRow(tenantId, fc.providerCallId)).toMatchObject({
      rows: 1,
      urgency: "emergency",
      flags: ["emergency:gas"],
      ended: false,
      transcript: null,
    });

    // The call ends: same row, now complete, same ID; processing is queued as usual.
    const ended = await recordCallEnded(
      app,
      boss,
      event(number, { providerCallId: fc.providerCallId }),
    );
    expect(ended).toEqual({
      outcome: "stored",
      tenantId,
      callId: alerted.callId,
      jobId: expect.any(String) as unknown,
    });
    expect(await callRow(tenantId, fc.providerCallId)).toMatchObject({
      rows: 1,
      urgency: "emergency",
      flags: ["emergency:gas"],
      ended: true,
      transcript: expect.stringContaining("kitchen tap") as unknown,
    });
    // A repeated webhook for the finished call is still a duplicate.
    expect(
      await recordCallEnded(app, boss, event(number, { providerCallId: fc.providerCallId })),
    ).toEqual({
      outcome: "duplicate",
      tenantId,
    });
  });

  it("is idempotent when the platform retries, and adds a second kind without duplicating the first", async () => {
    const { tenantId, number } = await makeTenant();
    const fc = functionCall(number);
    const first = await recordMidCallEmergency(app, boss, fc);
    await recordMidCallEmergency(app, boss, fc);
    const danger = await recordMidCallEmergency(app, boss, { ...fc, name: "danger_alert" });
    if (first.outcome !== "alerted" || danger.outcome !== "alerted") throw new Error("unreachable");
    expect(danger.callId).toBe(first.callId);
    expect(await callRow(tenantId, fc.providerCallId)).toMatchObject({
      rows: 1,
      flags: ["emergency:gas", "emergency:danger"],
    });
    // The queue's exclusive policy keeps one job per call while it's waiting.
    expect(await emergencyJobsFor(first.callId)).toHaveLength(1);
  });

  it("does nothing for a function it doesn't know or a number nobody owns", async () => {
    const { number } = await makeTenant();
    expect(await recordMidCallEmergency(app, boss, functionCall(number, "lookup_price"))).toEqual({
      outcome: "not-an-emergency-function",
      name: "lookup_price",
    });
    expect(await recordMidCallEmergency(app, boss, functionCall("+441632960999"))).toEqual({
      outcome: "unknown-number",
    });
    expect(
      await recordMidCallEmergency(app, boss, { ...functionCall(number), dialledNumber: null }),
    ).toEqual({ outcome: "unknown-number" });
  });
});
