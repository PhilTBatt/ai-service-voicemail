import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import { createAdminPool, createTenant } from "./cross-tenant.ts";
import { createPool } from "./pool.ts";
import { observeSyntheticCall } from "./synthetic-calls.ts";
import { withTenant } from "./tenant.ts";

const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);

afterAll(async () => {
  await Promise.all([app.end(), admin.end()]);
});

// Ofcom's drama range.
const CALLER = "+447700900321";

describe("observeSyntheticCall", () => {
  it("finds the synthetic caller's call since it was placed, with its messages", async () => {
    const tenantId = await createTenant(admin, {
      businessName: "Synthetic Plumbing",
      trade: "plumber",
    });
    await withTenant(app, tenantId, async (client) => {
      // Last night's test call from the same number, and someone else's call: neither counts.
      await client.query(
        `INSERT INTO calls (tenant_id, provider_call_id, caller_number, started_at)
         VALUES ($1, $2, $3, '2026-11-06T22:00:00Z'), ($1, $4, '+447700900322', '2026-11-07T22:00:10Z')`,
        [tenantId, `call_${randomUUID()}`, CALLER, `call_${randomUUID()}`],
      );
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO calls (tenant_id, provider_call_id, caller_number, started_at, ended_at,
                            urgency, summary)
         VALUES ($1, $2, $3, '2026-11-07T22:00:05Z', '2026-11-07T22:01:30Z', 'routine',
                 'Tap dripping in the kitchen.')
         RETURNING id`,
        [tenantId, `call_${randomUUID()}`, CALLER],
      );
      await client.query(
        `INSERT INTO notifications (tenant_id, call_id, channel, status, attempts, created_at,
                                    updated_at)
         VALUES ($1, $2, 'sms', 'delivered', 1, '2026-11-07T22:01:35Z', '2026-11-07T22:01:45Z')`,
        [tenantId, rows[0]!.id],
      );
    });

    expect(
      await observeSyntheticCall(app, tenantId, {
        callerNumber: CALLER,
        placedAt: new Date("2026-11-07T22:00:00Z"),
      }),
    ).toEqual({
      call: { endedAt: new Date("2026-11-07T22:01:30Z"), urgency: "routine", processed: true },
      notifications: [
        { channel: "sms", status: "delivered", statusAt: new Date("2026-11-07T22:01:45Z") },
      ],
    });
  });

  it("shows nothing until the call is stored", async () => {
    const tenantId = await createTenant(admin, {
      businessName: "Quiet Plumbing",
      trade: "plumber",
    });
    expect(
      await observeSyntheticCall(app, tenantId, { callerNumber: CALLER, placedAt: new Date() }),
    ).toEqual({ call: null, notifications: [] });
  });
});
