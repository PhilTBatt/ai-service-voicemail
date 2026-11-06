import { randomUUID } from "node:crypto";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROCESS_CALL_QUEUE, startQueue } from "../jobs/queue.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import { sampleCallEndedEvent } from "../testing/agent-fixture.ts";
import { recordCallEnded } from "./calls.ts";
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

const event = (to: string) =>
  sampleCallEndedEvent({ providerCallId: `call_${randomUUID()}`, dialledNumber: to });

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
      billable_seconds: 0, // the worker works this out
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
