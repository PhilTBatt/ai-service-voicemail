import { randomUUID } from "node:crypto";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminPool, createTenant } from "../db/cross-tenant.ts";
import { createPool } from "../db/pool.ts";
import { withTenant } from "../db/tenant.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import { enqueueNotificationsWith } from "./enqueue-notifications.ts";
import { startQueue } from "./queue.ts";

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

async function makeCall() {
  const tenantId = await createTenant(admin, { businessName: "Queue Plumbing", trade: "plumber" });
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO calls (tenant_id, provider_call_id, started_at, ended_at)
     VALUES ($1, $2, now(), now()) RETURNING id`,
    [tenantId, `call_${randomUUID()}`],
  );
  return { tenantId, callId: rows[0]!.id };
}

const jobsFor = async (callId: string) =>
  (
    await app.query<{ name: string; priority: number; data: unknown }>(
      "SELECT name, priority, data FROM pgboss.job WHERE singleton_key = $1 ORDER BY name",
      [callId],
    )
  ).rows;

describe("enqueueNotificationsWith", () => {
  it("queues a text and an email for an ordinary call", async () => {
    const { tenantId, callId } = await makeCall();
    const enqueue = enqueueNotificationsWith(boss);
    await withTenant(app, tenantId, (client) =>
      enqueue(client, { tenantId, callId, urgency: "routine" }),
    );
    expect(await jobsFor(callId)).toEqual([
      { name: "notify-email", priority: 0, data: { tenantId, callId } },
      { name: "notify-sms", priority: 0, data: { tenantId, callId } },
    ]);
  });

  it("adds the emergency job, with priority, for an emergency", async () => {
    const { tenantId, callId } = await makeCall();
    const enqueue = enqueueNotificationsWith(boss);
    await withTenant(app, tenantId, (client) =>
      enqueue(client, { tenantId, callId, urgency: "emergency" }),
    );
    expect((await jobsFor(callId)).map((job) => [job.name, job.priority])).toEqual([
      ["notify-email", 0],
      ["notify-emergency", 10],
      ["notify-sms", 0],
    ]);
  });

  it("queues nothing if the transaction it runs in rolls back", async () => {
    const { tenantId, callId } = await makeCall();
    const enqueue = enqueueNotificationsWith(boss);
    await expect(
      withTenant(app, tenantId, async (client) => {
        await enqueue(client, { tenantId, callId, urgency: null });
        throw new Error("something else in the transaction failed");
      }),
    ).rejects.toThrow("something else");
    expect(await jobsFor(callId)).toEqual([]);
  });
});
