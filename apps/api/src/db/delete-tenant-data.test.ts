import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { TEST_ADMIN_DATABASE_URL } from "../testing/databases.ts";
import { createAdminPool, createTenant, deleteTenantData } from "./cross-tenant.ts";

const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);
const NOW = new Date("2026-11-10T12:00:00Z");

afterAll(async () => {
  await admin.end();
});

describe("deleteTenantData", () => {
  it("deletes a business's calls a batch at a time, inside one transaction, and counts them all", async () => {
    const tenantId = await createTenant(admin, { businessName: "Batch Delete", trade: "roofer" });
    for (let i = 0; i < 5; i++) {
      await admin.query(
        `INSERT INTO calls (tenant_id, provider_call_id, started_at, ended_at, transcript)
         VALUES ($1, $2, $3, $3, 'agent: hi')`,
        [tenantId, `call_${randomUUID()}`, NOW],
      );
    }

    const result = await deleteTenantData(admin, tenantId, {
      now: NOW,
      actorUserId: null,
      batchSize: 2,
    });
    expect(result).toEqual({ calls: 5 });

    const remaining = await admin.query(
      "SELECT count(*)::int AS n FROM calls WHERE tenant_id = $1",
      [tenantId],
    );
    expect(remaining.rows[0]).toEqual({ n: 0 });
    const audit = await admin.query<{ details: { calls: number } }>(
      "SELECT details FROM audit_log WHERE tenant_id = $1 AND action = 'tenant.data-deleted'",
      [tenantId],
    );
    expect(audit.rows[0]?.details.calls).toBe(5);
  });
});
