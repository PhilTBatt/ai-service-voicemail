import { randomUUID } from "node:crypto";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { saveAgentProfile, type AgentProfileInput } from "../db/agent-profiles.ts";
import { assignPhoneNumber, createAdminPool, createTenant } from "../db/cross-tenant.ts";
import { createPool } from "../db/pool.ts";
import { withTenant } from "../db/tenant.ts";
import { FakeVoiceProvider } from "../providers/voice.fake.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import { SYNC_AGENT_QUEUE, startQueue } from "./queue.ts";
import { enqueueSyncAgent, runSyncAgent } from "./sync-agent.ts";

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

const PROFILE: AgentProfileInput = {
  trade: "plumber",
  services: ["boiler repairs"],
  serviceAreas: ["Leeds"],
  openingHours: { mon: { open: "08:00", close: "18:00" } },
  holidayMode: false,
  holidayUntil: null,
  faqs: [],
  emergencyPolicy: { takesEmergencyCalls: true },
};

/** A fictional tenant with a drama-range number. */
async function makeTenant(contactName: string | null = "Sam") {
  const tenantId = await createTenant(admin, {
    businessName: "Sync Plumbing",
    trade: "plumber",
    status: "demo",
    ...(contactName !== null && { contactName }),
  });
  const number = `+441632960${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
  await admin.query(
    "UPDATE phone_numbers SET status = 'released', released_at = now() WHERE number = $1 AND status = 'active'",
    [number],
  );
  await assignPhoneNumber(admin, tenantId, number, `PN${randomUUID()}`);
  return { tenantId, number };
}

const profileRow = (tenantId: string, version: number) =>
  withTenant(app, tenantId, async (client) => {
    const { rows } = await client.query<{
      provider_agent_id: string | null;
      synced_at: Date | null;
      sync_error: string | null;
    }>(
      "SELECT provider_agent_id, synced_at, sync_error FROM agent_profiles WHERE tenant_id = $1 AND version = $2",
      [tenantId, version],
    );
    return rows[0];
  });

describe("saveAgentProfile", () => {
  it("stores each save as a new version and queues a sync for it", async () => {
    const { tenantId } = await makeTenant();
    expect(await saveAgentProfile(app, boss, tenantId, PROFILE)).toBe(1);
    expect(await saveAgentProfile(app, boss, tenantId, { ...PROFILE, services: ["taps"] })).toBe(2);

    const { rows } = await app.query<{ singleton_key: string; state: string }>(
      "SELECT singleton_key, state FROM pgboss.job WHERE name = $1 AND singleton_key LIKE $2 ORDER BY singleton_key",
      [SYNC_AGENT_QUEUE, `${tenantId}:%`],
    );
    expect(rows).toEqual([
      { singleton_key: `${tenantId}:1`, state: "created" },
      { singleton_key: `${tenantId}:2`, state: "created" },
    ]);
  });

  it("won't queue a second sync for a version that's already queued", async () => {
    const { tenantId } = await makeTenant();
    expect(await enqueueSyncAgent(boss, { tenantId, profileVersion: 7 })).toEqual(
      expect.any(String),
    );
    expect(await enqueueSyncAgent(boss, { tenantId, profileVersion: 7 })).toBeNull();
  });
});

describe("runSyncAgent", () => {
  it("records the agent before attaching the number, so a retry updates it rather than creating another", async () => {
    const { tenantId } = await makeTenant();
    const version = await saveAgentProfile(app, boss, tenantId, PROFILE);
    const voice = new FakeVoiceProvider();
    const attach = voice.attachNumber.bind(voice);
    voice.attachNumber = () => Promise.reject(new Error("number not imported yet"));

    await expect(
      runSyncAgent({ pool: app, voice, alert: vi.fn() }, { tenantId, profileVersion: version }),
    ).rejects.toThrow("number not imported yet");
    const afterFailure = await profileRow(tenantId, version);
    expect(afterFailure).toMatchObject({
      provider_agent_id: expect.any(String) as unknown,
      synced_at: null,
    });

    voice.attachNumber = attach;
    expect(await runSyncAgent({ pool: app, voice }, { tenantId, profileVersion: version })).toBe(
      "synced",
    );
    expect(voice.agents.size).toBe(1);
    expect((await profileRow(tenantId, version))?.provider_agent_id).toBe(
      afterFailure?.provider_agent_id,
    );
  });

  it("builds the agent from the tenant and profile, attaches the number, and records the sync", async () => {
    const { tenantId, number } = await makeTenant();
    const version = await saveAgentProfile(app, boss, tenantId, PROFILE);
    const voice = new FakeVoiceProvider();

    expect(await runSyncAgent({ pool: app, voice }, { tenantId, profileVersion: version })).toBe(
      "synced",
    );

    const [providerAgentId, definition] = [...voice.agents.entries()][0]!;
    expect(definition.opening).toContain("you're through to Sync Plumbing");
    expect(definition.opening).toContain("so Sam can call you back");
    expect(definition.instructions).toContain("- boiler repairs");
    expect(definition.limits.maxCallSeconds).toBe(180); // demo tenant
    expect(voice.numbers.get(number)).toBe(providerAgentId);
    expect(await profileRow(tenantId, version)).toMatchObject({
      provider_agent_id: providerAgentId,
      synced_at: expect.any(Date) as unknown,
      sync_error: null,
    });
  });

  it("does nothing the second time for the same version", async () => {
    const { tenantId } = await makeTenant();
    const version = await saveAgentProfile(app, boss, tenantId, PROFILE);
    const voice = new FakeVoiceProvider();
    const upsert = vi.spyOn(voice, "upsertAgent");

    await runSyncAgent({ pool: app, voice }, { tenantId, profileVersion: version });
    expect(await runSyncAgent({ pool: app, voice }, { tenantId, profileVersion: version })).toBe(
      "already-synced",
    );
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("updates the same platform agent for a new profile version", async () => {
    const { tenantId } = await makeTenant();
    const voice = new FakeVoiceProvider();
    const v1 = await saveAgentProfile(app, boss, tenantId, PROFILE);
    await runSyncAgent({ pool: app, voice }, { tenantId, profileVersion: v1 });
    const v2 = await saveAgentProfile(app, boss, tenantId, { ...PROFILE, services: ["taps"] });
    await runSyncAgent({ pool: app, voice }, { tenantId, profileVersion: v2 });

    expect(voice.agents.size).toBe(1);
    const [agentId] = [...voice.agents.keys()];
    expect((await profileRow(tenantId, v1))?.provider_agent_id).toBe(agentId);
    expect((await profileRow(tenantId, v2))?.provider_agent_id).toBe(agentId);
    expect(voice.agents.get(agentId!)?.instructions).toContain("- taps");
  });

  it("records the error and raises an alert when the platform fails, then rethrows so the queue retries", async () => {
    const { tenantId } = await makeTenant();
    const version = await saveAgentProfile(app, boss, tenantId, PROFILE);
    const voice = new FakeVoiceProvider();
    voice.upsertAgent = () => Promise.reject(new Error("Retell is down"));
    const alert = vi.fn();

    await expect(
      runSyncAgent({ pool: app, voice, alert }, { tenantId, profileVersion: version }),
    ).rejects.toThrow("Retell is down");
    expect(await profileRow(tenantId, version)).toMatchObject({
      synced_at: null,
      sync_error: "Retell is down",
    });
    expect(alert).toHaveBeenCalledWith(
      "agent-sync-failed",
      expect.objectContaining({ tenantId, profileVersion: version }),
    );
  });

  it("refuses to sync a tenant that has no contact name yet", async () => {
    const { tenantId } = await makeTenant(null);
    const version = await saveAgentProfile(app, boss, tenantId, PROFILE);
    const voice = new FakeVoiceProvider();

    await expect(
      runSyncAgent({ pool: app, voice, alert: vi.fn() }, { tenantId, profileVersion: version }),
    ).rejects.toThrow(/contact name/);
    expect(voice.agents.size).toBe(0);
    expect((await profileRow(tenantId, version))?.sync_error).toMatch(/contact name/);
  });

  // The worker drains the jobs queued by the tests above first, so this needs longer than 5 s.
  it(
    "end to end: a saved profile is synced by a worker through the queue",
    { timeout: 20_000 },
    async () => {
      const voice = new FakeVoiceProvider();
      await boss.work(
        SYNC_AGENT_QUEUE,
        { pollingIntervalSeconds: 0.5 },
        async (jobs: { data: unknown }[]) => {
          for (const job of jobs) {
            await runSyncAgent(
              { pool: app, voice },
              job.data as { tenantId: string; profileVersion: number },
            );
          }
        },
      );
      try {
        const { tenantId } = await makeTenant();
        const version = await saveAgentProfile(app, boss, tenantId, PROFILE);

        const deadline = Date.now() + 15_000;
        let row = await profileRow(tenantId, version);
        while (!row?.synced_at && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          row = await profileRow(tenantId, version);
        }
        expect(row).toMatchObject({ synced_at: expect.any(Date) as unknown, sync_error: null });
        // The worker also drains jobs the tests above queued, so check this tenant, not a count.
        expect([...voice.agents.values()].some((d) => d.tenantId === tenantId)).toBe(true);
      } finally {
        await boss.offWork(SYNC_AGENT_QUEUE);
      }
    },
  );
});
