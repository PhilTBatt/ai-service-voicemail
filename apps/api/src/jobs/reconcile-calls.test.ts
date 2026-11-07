import { randomUUID } from "node:crypto";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordCallEnded, recordMidCallEmergency } from "../db/calls.ts";
import { assignPhoneNumber, createAdminPool, createTenant } from "../db/cross-tenant.ts";
import { createPool } from "../db/pool.ts";
import { withTenant } from "../db/tenant.ts";
import { FakeVoiceProvider } from "../providers/voice.fake.ts";
import { sampleCallEndedEvent } from "../testing/agent-fixture.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import { startQueue } from "./queue.ts";
import { reconcileCalls } from "./reconcile-calls.ts";

const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);
const NOW = new Date("2026-11-07T20:00:00Z");
let boss: PgBoss;

beforeAll(async () => {
  boss = await startQueue(TEST_DATABASE_URL);
});

afterAll(async () => {
  await boss.stop({ graceful: false, close: true });
  await Promise.all([app.end(), admin.end()]);
});

async function makeTenant() {
  const tenantId = await createTenant(admin, { businessName: "Reconcile Gas", trade: "plumber" });
  const number = `+441134960${String(Math.floor(Math.random() * 990)).padStart(3, "0")}`;
  await admin.query(
    "UPDATE phone_numbers SET status = 'released', released_at = now() WHERE number = $1 AND status = 'active'",
    [number],
  );
  await assignPhoneNumber(admin, tenantId, number, `PN${randomUUID()}`);
  return { tenantId, number };
}

const endedCall = (to: string, minutesAgo: number) =>
  sampleCallEndedEvent({
    providerCallId: `call_${randomUUID()}`,
    dialledNumber: to,
    startedAt: new Date(NOW.getTime() - (minutesAgo + 2) * 60_000),
    endedAt: new Date(NOW.getTime() - minutesAgo * 60_000),
  });

const rowFor = (tenantId: string, providerCallId: string) =>
  withTenant(
    app,
    tenantId,
    async (client) =>
      (
        await client.query<{ ended: boolean; transcript: string | null; urgency: string | null }>(
          `SELECT ended_at IS NOT NULL AS ended, transcript, urgency
           FROM calls WHERE provider_call_id = $1`,
          [providerCallId],
        )
      ).rows,
  );

describe("reconcileCalls", () => {
  it("stores calls the webhook missed, skips ones already stored, and completes a provisional row", async () => {
    const { tenantId, number } = await makeTenant();
    const voice = new FakeVoiceProvider();
    const missed = endedCall(number, 30);
    const known = endedCall(number, 45);
    const midCall = endedCall(number, 10);
    voice.endedCalls.push(missed, known, midCall);
    await recordCallEnded(app, boss, known);
    await recordMidCallEmergency(app, boss, {
      type: "function_call",
      name: "gas_emergency_alert",
      providerCallId: midCall.providerCallId,
      providerAgentId: midCall.providerAgentId,
      dialledNumber: number,
      callerNumber: midCall.callerNumber,
    });

    expect(await reconcileCalls({ pool: app, admin, boss, voice, now: () => NOW })).toEqual({
      listed: 3,
      alreadyStored: 1,
      stored: 2,
      duplicate: 0,
      unknownNumber: 0,
    });
    expect(await rowFor(tenantId, missed.providerCallId)).toEqual([
      { ended: true, transcript: expect.stringContaining("kitchen tap") as unknown, urgency: null },
    ]);
    // The mid-call row is now complete and still an emergency.
    expect(await rowFor(tenantId, midCall.providerCallId)).toEqual([
      { ended: true, transcript: expect.any(String) as unknown, urgency: "emergency" },
    ]);

    // A second run finds everything stored.
    expect(await reconcileCalls({ pool: app, admin, boss, voice, now: () => NOW })).toMatchObject({
      alreadyStored: 3,
      stored: 0,
    });
  });

  it("only looks back over the configured window", async () => {
    const { number } = await makeTenant();
    const voice = new FakeVoiceProvider();
    voice.endedCalls.push(endedCall(number, 25 * 60));
    expect(
      await reconcileCalls({ pool: app, admin, boss, voice, now: () => NOW, lookbackHours: 24 }),
    ).toMatchObject({ listed: 0 });
  });

  it("counts calls to numbers nobody owns without failing", async () => {
    const voice = new FakeVoiceProvider();
    voice.endedCalls.push(endedCall("+441632960997", 5));
    expect(await reconcileCalls({ pool: app, admin, boss, voice, now: () => NOW })).toMatchObject({
      listed: 1,
      unknownNumber: 1,
    });
  });
});
