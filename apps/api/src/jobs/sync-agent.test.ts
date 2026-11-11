import { randomUUID } from "node:crypto";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { saveAgentProfile, waitForSync, type AgentProfileInput } from "../db/agent-profiles.ts";
import {
  assignPhoneNumber,
  createAdminPool,
  createTenant,
  listLatestProfilesWithLiveAgents,
} from "../db/cross-tenant.ts";
import { createPool } from "../db/pool.ts";
import { withTenant } from "../db/tenant.ts";
import { FakeVoiceProvider } from "../providers/voice.fake.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import { SYNC_AGENT_QUEUE, startQueue } from "./queue.ts";
import { enqueueAgentResyncs, enqueueSyncAgent, runSyncAgent } from "./sync-agent.ts";

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
  // Below 990: the 990 to 999 endings are reserved for "a number nobody owns" fixtures.
  const number = `+441632960${String(Math.floor(Math.random() * 990)).padStart(3, "0")}`;
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
  it("builds the agent from the tenant and profile and records the sync", async () => {
    const { tenantId } = await makeTenant();
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

  describe("waitForSync (what npm run demo:profile reports)", () => {
    // A clock that moves only when the wait sleeps, so the tests take no real time.
    const clock = () => {
      let at = 0;
      return { now: () => at, sleep: (ms: number) => ((at += ms), Promise.resolve()) };
    };

    it("answers synced once the job has run", async () => {
      const { tenantId } = await makeTenant();
      const version = await saveAgentProfile(app, boss, tenantId, PROFILE);
      await runSyncAgent(
        { pool: app, voice: new FakeVoiceProvider(), alert: vi.fn() },
        { tenantId, profileVersion: version },
      );
      expect(await waitForSync(app, tenantId, version, { timeoutMs: 0, ...clock() })).toMatchObject(
        { state: "synced", syncedAt: expect.any(Date) as unknown },
      );
    });

    it("keeps waiting through a failed attempt, which the queue retries, and gives the error at the deadline", async () => {
      const { tenantId } = await makeTenant();
      const version = await saveAgentProfile(app, boss, tenantId, PROFILE);
      const voice = new FakeVoiceProvider();
      voice.upsertAgent = () => Promise.reject(new Error("Retell is down"));
      await expect(
        runSyncAgent({ pool: app, voice, alert: vi.fn() }, { tenantId, profileVersion: version }),
      ).rejects.toThrow();
      const time = clock();
      expect(
        await waitForSync(app, tenantId, version, { timeoutMs: 6_000, intervalMs: 2_000, ...time }),
      ).toEqual({ state: "failed", error: "Retell is down" });
      expect(time.now()).toBe(6_000); // it waited the whole time, checking every 2 seconds
    });

    it("answers waiting when nothing has run the job (no worker)", async () => {
      const { tenantId } = await makeTenant();
      const version = await saveAgentProfile(app, boss, tenantId, PROFILE);
      expect(await waitForSync(app, tenantId, version, { timeoutMs: 4_000, ...clock() })).toEqual({
        state: "waiting",
      });
    });

    it("says so when the version doesn't exist", async () => {
      const { tenantId } = await makeTenant();
      await expect(waitForSync(app, tenantId, 99, { timeoutMs: 0, ...clock() })).rejects.toThrow(
        /No profile version 99/,
      );
    });
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
    { timeout: 40_000 },
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

        const deadline = Date.now() + 30_000;
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

describe("runSyncAgent ordering", () => {
  it("won't let a late retry of an older version overwrite a newer synced agent", async () => {
    const { tenantId } = await makeTenant();
    await saveAgentProfile(app, boss, tenantId, PROFILE);
    await saveAgentProfile(app, boss, tenantId, { ...PROFILE, services: ["taps"] });
    const voice = new FakeVoiceProvider();
    expect(await runSyncAgent({ pool: app, voice }, { tenantId, profileVersion: 2 })).toBe(
      "synced",
    );
    expect(await runSyncAgent({ pool: app, voice }, { tenantId, profileVersion: 1 })).toBe(
      "superseded",
    );
    expect(voice.agents.size).toBe(1);
    expect([...voice.agents.values()][0]?.profileVersion).toBe(2);
    expect((await profileRow(tenantId, 1))?.synced_at).toBeNull();
  });
});

// Before 2026-11-11 a profile was synced once per version, so a release that changed the prompt
// (the gas-reminder and no-money fixes, say) never reached an agent until its business saved a
// change. Now a synced version is sent again when what it would send has changed.
describe("runSyncAgent after a release", () => {
  const fingerprintOf = (tenantId: string, version: number) =>
    withTenant(app, tenantId, async (client) => {
      const { rows } = await client.query<{ synced_fingerprint: string | null }>(
        "SELECT synced_fingerprint FROM agent_profiles WHERE tenant_id = $1 AND version = $2",
        [tenantId, version],
      );
      return rows[0]?.synced_fingerprint;
    });

  it("sends a synced version again, to the same agent, only when what it would send has changed", async () => {
    const { tenantId } = await makeTenant();
    const version = await saveAgentProfile(app, boss, tenantId, PROFILE);
    const voice = new FakeVoiceProvider();
    const upsert = vi.spyOn(voice, "upsertAgent");
    await runSyncAgent({ pool: app, voice }, { tenantId, profileVersion: version });
    const first = await profileRow(tenantId, version);
    expect(await fingerprintOf(tenantId, version)).toBe(
      voice.agentFingerprint([...voice.agents.values()][0]!),
    );

    // The same build: nothing sent.
    expect(await runSyncAgent({ pool: app, voice }, { tenantId, profileVersion: version })).toBe(
      "already-synced",
    );
    expect(upsert).toHaveBeenCalledTimes(1);

    // A new build that would send something else (a prompt change, a new webhook address).
    vi.spyOn(voice, "agentFingerprint").mockReturnValue("the next build");
    expect(await runSyncAgent({ pool: app, voice }, { tenantId, profileVersion: version })).toBe(
      "synced",
    );
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls[1]?.[0].existingProviderAgentId).toBe(first?.provider_agent_id);
    expect(await fingerprintOf(tenantId, version)).toBe("the next build");
    expect(await profileRow(tenantId, version)).toMatchObject({
      provider_agent_id: first?.provider_agent_id,
      sync_error: null,
    });

    // And then it's settled again.
    expect(await runSyncAgent({ pool: app, voice }, { tenantId, profileVersion: version })).toBe(
      "already-synced",
    );
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it("sends a profile synced before fingerprints were kept once more, then leaves it", async () => {
    const { tenantId } = await makeTenant();
    const version = await saveAgentProfile(app, boss, tenantId, PROFILE);
    const voice = new FakeVoiceProvider();
    await runSyncAgent({ pool: app, voice }, { tenantId, profileVersion: version });
    await withTenant(app, tenantId, (client) =>
      client.query("UPDATE agent_profiles SET synced_fingerprint = NULL WHERE tenant_id = $1", [
        tenantId,
      ]),
    );
    const upsert = vi.spyOn(voice, "upsertAgent");
    expect(await runSyncAgent({ pool: app, voice }, { tenantId, profileVersion: version })).toBe(
      "synced",
    );
    expect(await runSyncAgent({ pool: app, voice }, { tenantId, profileVersion: version })).toBe(
      "already-synced",
    );
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("never sends an older version over a newer one, however much has changed", async () => {
    const { tenantId } = await makeTenant();
    await saveAgentProfile(app, boss, tenantId, PROFILE);
    const voice = new FakeVoiceProvider();
    await runSyncAgent({ pool: app, voice }, { tenantId, profileVersion: 1 });
    await saveAgentProfile(app, boss, tenantId, { ...PROFILE, services: ["taps"] });
    await runSyncAgent({ pool: app, voice }, { tenantId, profileVersion: 2 });
    vi.spyOn(voice, "agentFingerprint").mockReturnValue("the next build");
    const upsert = vi.spyOn(voice, "upsertAgent");
    expect(await runSyncAgent({ pool: app, voice }, { tenantId, profileVersion: 1 })).toBe(
      "superseded",
    );
    expect(upsert).not.toHaveBeenCalled();
    expect([...voice.agents.values()][0]?.profileVersion).toBe(2);
  });

  it("queues the latest version of each business with a live agent, not one that's left or never had one", async () => {
    const voice = new FakeVoiceProvider();
    // Live, on its second version.
    const live = (await makeTenant()).tenantId;
    await saveAgentProfile(app, boss, live, PROFILE);
    await runSyncAgent({ pool: app, voice }, { tenantId: live, profileVersion: 1 });
    await saveAgentProfile(app, boss, live, { ...PROFILE, services: ["taps"] });
    await runSyncAgent({ pool: app, voice }, { tenantId: live, profileVersion: 2 });
    // Live on version 1; version 2's sync failed (a platform outage when it was saved): retried.
    const failedLatest = (await makeTenant()).tenantId;
    await saveAgentProfile(app, boss, failedLatest, PROFILE);
    await runSyncAgent({ pool: app, voice }, { tenantId: failedLatest, profileVersion: 1 });
    await saveAgentProfile(app, boss, failedLatest, { ...PROFILE, services: ["taps"] });
    // Never had an agent (onboarding without a contact name): it would only fail again.
    const neverSynced = (await makeTenant(null)).tenantId;
    await saveAgentProfile(app, boss, neverSynced, PROFILE);
    // Left: its calls hear "service has ended", never the agent.
    const left = (await makeTenant()).tenantId;
    await saveAgentProfile(app, boss, left, PROFILE);
    await runSyncAgent({ pool: app, voice }, { tenantId: left, profileVersion: 1 });
    await admin.query("UPDATE tenants SET status = 'cancelled' WHERE id = $1", [left]);

    const listed = await listLatestProfilesWithLiveAgents(admin);
    expect(listed).toContainEqual({ tenantId: live, version: 2 });
    expect(listed).toContainEqual({ tenantId: failedLatest, version: 2 });
    expect(listed.map((row) => row.tenantId)).not.toContain(neverSynced);
    expect(listed.map((row) => row.tenantId)).not.toContain(left);

    // Queued as ordinary sync jobs (the same queue and key as a business's own edits, so they
    // take turns), one per business listed. Other test files' businesses are listed too.
    const send = vi.fn((_queue: string, _data: unknown, _options: unknown) =>
      Promise.resolve("job-id"),
    );
    const counts = await enqueueAgentResyncs(admin, { send } as unknown as PgBoss);
    expect(counts.failed).toBe(0);
    expect(counts.queued).toBeGreaterThanOrEqual(2);
    const mine = send.mock.calls
      .filter(([, data]) =>
        [live, failedLatest, neverSynced, left].includes((data as { tenantId: string }).tenantId),
      )
      .map(([, data]) => data);
    expect(mine).toHaveLength(2);
    expect(mine).toEqual(
      expect.arrayContaining([
        { tenantId: live, profileVersion: 2 },
        { tenantId: failedLatest, profileVersion: 2 },
      ]),
    );
    expect(send).toHaveBeenCalledWith(
      SYNC_AGENT_QUEUE,
      { tenantId: live, profileVersion: 2 },
      { singletonKey: `${live}:2` },
    );
  });

  it("carries on queueing the others when one can't be queued", async () => {
    const voice = new FakeVoiceProvider();
    const [first, second] = [(await makeTenant()).tenantId, (await makeTenant()).tenantId];
    for (const tenantId of [first, second]) {
      await saveAgentProfile(app, boss, tenantId, PROFILE);
      await runSyncAgent({ pool: app, voice }, { tenantId, profileVersion: 1 });
    }
    const send = vi.fn((_queue: string, data: unknown) =>
      (data as { tenantId: string }).tenantId === first
        ? Promise.reject(new Error("queue hiccup"))
        : Promise.resolve("job-id"),
    );
    const counts = await enqueueAgentResyncs(admin, { send } as unknown as PgBoss);
    expect(counts.failed).toBe(1);
    expect(send).toHaveBeenCalledWith(
      SYNC_AGENT_QUEUE,
      { tenantId: second, profileVersion: 1 },
      { singletonKey: `${second}:1` },
    );
  });

  it("doesn't sync a business that's leaving, so no agent is made after its own is deleted", async () => {
    const { tenantId } = await makeTenant();
    await saveAgentProfile(app, boss, tenantId, PROFILE);
    const voice = new FakeVoiceProvider();
    await runSyncAgent({ pool: app, voice }, { tenantId, profileVersion: 1 });
    await admin.query("UPDATE tenants SET status = 'cancelling' WHERE id = $1", [tenantId]);
    vi.spyOn(voice, "agentFingerprint").mockReturnValue("the next build");
    const upsert = vi.spyOn(voice, "upsertAgent");
    expect(await runSyncAgent({ pool: app, voice }, { tenantId, profileVersion: 1 })).toBe(
      "business-left",
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it("keeps a live agent whose profile no longer builds, says so once, and doesn't mark it failed", async () => {
    const { tenantId } = await makeTenant();
    await saveAgentProfile(app, boss, tenantId, PROFILE);
    const voice = new FakeVoiceProvider();
    await runSyncAgent({ pool: app, voice }, { tenantId, profileVersion: 1 });
    // Something the build needs has gone since it synced.
    await admin.query("UPDATE tenants SET contact_name = NULL WHERE id = $1", [tenantId]);
    const upsert = vi.spyOn(voice, "upsertAgent");
    const alert = vi.fn();
    expect(await runSyncAgent({ pool: app, voice, alert }, { tenantId, profileVersion: 1 })).toBe(
      "already-synced",
    );
    expect(upsert).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(
      "agent-sync-failed",
      expect.objectContaining({ tenantId, profileVersion: 1, stillLive: true }),
    );
    expect(await profileRow(tenantId, 1)).toMatchObject({ sync_error: null });
  });
});

describe("saveAgentProfile transaction", () => {
  it("saves no version if the sync job can't be queued", async () => {
    const { tenantId } = await makeTenant();
    const brokenBoss = { send: () => Promise.reject(new Error("queue down")) } as unknown as PgBoss;
    await expect(saveAgentProfile(app, brokenBoss, tenantId, PROFILE)).rejects.toThrow(
      "queue down",
    );
    const count = await withTenant(
      app,
      tenantId,
      async (client) =>
        (await client.query("SELECT 1 FROM agent_profiles WHERE tenant_id = $1", [tenantId]))
          .rowCount,
    );
    expect(count).toBe(0);
  });
});
