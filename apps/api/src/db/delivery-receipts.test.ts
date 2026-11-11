// The race between a delivery receipt and the send job saving the message's ID, played out
// one way and then the other on real Postgres: each side takes the lock on the ID, so whichever
// goes second must see what the first committed. Plus how long an unmatched receipt is kept.
// (The routes' own tests show a receipt that comes before the save, end to end.)
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { deliverNotification } from "../jobs/deliver-notification.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import { createAdminPool, createTenant } from "./cross-tenant.ts";
import {
  EARLY_RECEIPT_KEEP_MINUTES,
  applyEarlyReceipt,
  recordReceipt,
  type DeliveryReceipt,
} from "./delivery-receipts.ts";
import { createPool } from "./pool.ts";
import { withTenant } from "./tenant.ts";

const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);
const TO = "+447700900001";
const outbound = { nodeEnv: "test" as const, allowlist: new Set([TO]) };

afterAll(async () => {
  await Promise.all([app.end(), admin.end()]);
});

const newRef = () => `SM${randomBytes(16).toString("hex")}`;

const undelivered = (providerRef: string): DeliveryReceipt => ({
  medium: "sms",
  providerRef,
  status: "undelivered",
  failureCode: "30003",
  alert: { name: "sms-undelivered", details: { errorCode: "30003" } },
});

async function makeCall() {
  const tenantId = await createTenant(admin, { businessName: "Race Plumbing", trade: "plumber" });
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO calls (tenant_id, provider_call_id, started_at, ended_at, summary)
     VALUES ($1, $2, now(), now(), 'A job.') RETURNING id`,
    [tenantId, `call_${randomUUID()}`],
  );
  return { tenantId, callId: rows[0]!.id };
}

const statusOf = async (ref: string) =>
  (
    await admin.query<{ status: string; failure_code: string | null }>(
      "SELECT status, failure_code FROM notifications WHERE provider_ref = $1",
      [ref],
    )
  ).rows[0];

/** Resolves once some connection is waiting for the lock on this message ID. */
async function someoneWaitsFor(ref: string) {
  // A bigint advisory key shows in pg_locks as its high half (classid) and low half (objid).
  await vi.waitFor(
    async () => {
      const { rows } = await app.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks
         WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1
           AND classid = ((hashtext($1)::bigint >> 32) & 4294967295)::oid
           AND objid = (hashtext($1)::bigint & 4294967295)::oid`,
        [`delivery-receipt:${ref}`],
      );
      expect(rows[0]!.n).toBe(1);
    },
    // Well inside the test's own 5 seconds, so a missing lock fails here, saying so.
    { timeout: 2_000, interval: 20 },
  );
}

describe("a receipt racing the send job", () => {
  it("waits while the ID is being saved, then finds it and applies, alerting once", async () => {
    const { tenantId, callId } = await makeCall();
    const ref = newRef();
    await admin.query(
      `INSERT INTO notifications (tenant_id, call_id, channel, status, attempts)
       VALUES ($1, $2, 'sms', 'pending', 1)`,
      [tenantId, callId],
    );
    // The send job's transaction: the ID saved, nothing kept for it yet, not yet committed.
    let commit!: () => void;
    const gate = new Promise<void>((resolve) => (commit = resolve));
    let saved!: () => void;
    const savedNotCommitted = new Promise<void>((resolve) => (saved = resolve));
    const sending = withTenant(app, tenantId, async (client) => {
      await client.query(
        "UPDATE notifications SET status = 'sent', provider_ref = $2 WHERE call_id = $1",
        [callId, ref],
      );
      const early = await applyEarlyReceipt(client, "sms", ref);
      saved();
      await gate;
      return early;
    });
    await savedNotCommitted;

    // The receipt can't see the uncommitted ID. Without the lock it would be kept now, after
    // the send job had already looked, and never applied.
    const alert = vi.fn();
    const receiving = recordReceipt(app, undelivered(ref), alert);
    try {
      await someoneWaitsFor(ref);
    } finally {
      commit();
    }

    expect(await sending).toBeNull();
    expect(await receiving).toEqual({ tenantId });
    expect(await statusOf(ref)).toEqual({ status: "undelivered", failure_code: "30003" });
    expect(alert.mock.calls).toEqual([
      ["sms-undelivered", { tenantId, callId, errorCode: "30003" }],
    ]);
  });

  it("is applied by a send job that saves the ID while it's being kept", async () => {
    const { tenantId, callId } = await makeCall();
    const ref = newRef();
    const key = `delivery-receipt:${ref}`;
    // Stands in for the receipt's transaction: holds the lock while the receipt is kept.
    const holder = await app.connect();
    let broken = true;
    try {
      await holder.query("SELECT pg_advisory_lock(hashtext($1))", [key]);
      const alert = vi.fn();
      const sending = deliverNotification(
        { pool: app, outbound, alert },
        {
          tenantId,
          callId,
          channel: "sms",
          to: TO,
          send: () => Promise.resolve({ providerRef: ref }),
        },
      );
      // Without its own lock the send job would have looked already, found nothing, and gone.
      await someoneWaitsFor(ref);
      await holder.query(
        `INSERT INTO early_receipts (medium, provider_ref, status, failure_code, alert, alert_details)
         VALUES ('sms', $1, 'undelivered', '30003', 'sms-undelivered', '{"errorCode": "30003"}')`,
        [ref],
      );
      await holder.query("SELECT pg_advisory_unlock(hashtext($1))", [key]);
      broken = false;

      expect(await sending).toBe("sent");
      expect(await statusOf(ref)).toEqual({ status: "undelivered", failure_code: "30003" });
      expect(alert.mock.calls).toEqual([
        ["sms-undelivered", { tenantId, callId, errorCode: "30003" }],
      ]);
      // Taken back: nothing of it is left to apply again.
      expect(
        (await app.query("SELECT 1 FROM early_receipts WHERE provider_ref = $1", [ref])).rowCount,
      ).toBe(0);
    } finally {
      // A connection that may still hold the lock is closed rather than pooled.
      holder.release(broken);
    }
  });
});

describe("a receipt no message has the ID of", () => {
  it("is kept with its latest verdict only, for an hour at most", async () => {
    const [stale, fresh, ref] = [newRef(), newRef(), newRef()];
    await app.query(
      `INSERT INTO early_receipts (medium, provider_ref, status, received_at)
       VALUES ('sms', $1, 'delivered', now() - make_interval(mins => $3)),
              ('sms', $2, 'delivered', now() - make_interval(mins => $4))`,
      [stale, fresh, EARLY_RECEIPT_KEEP_MINUTES + 1, EARLY_RECEIPT_KEEP_MINUTES - 1],
    );
    const alert = vi.fn();
    const delivered: DeliveryReceipt = {
      medium: "sms",
      providerRef: ref,
      status: "delivered",
      failureCode: null,
      alert: null,
    };
    expect(await recordReceipt(app, delivered, alert)).toEqual({ tenantId: null });
    expect(await recordReceipt(app, undelivered(ref), alert)).toEqual({ tenantId: null });
    // Nobody to tell yet: the alert waits for the message to be matched.
    expect(alert).not.toHaveBeenCalled();

    const { rows } = await app.query(
      `SELECT provider_ref, status, failure_code, alert, alert_details FROM early_receipts
       WHERE provider_ref = ANY($1) ORDER BY provider_ref = $2`,
      [[stale, fresh, ref], ref],
    );
    expect(rows).toEqual([
      {
        provider_ref: fresh,
        status: "delivered",
        failure_code: null,
        alert: null,
        alert_details: {},
      },
      {
        provider_ref: ref,
        status: "undelivered",
        failure_code: "30003",
        alert: "sms-undelivered",
        alert_details: { errorCode: "30003" },
      },
    ]);
  });

  it("is never applied to a message of the other medium that happens to share the ID", async () => {
    const { tenantId, callId } = await makeCall();
    const ref = newRef();
    await app.query(
      `INSERT INTO early_receipts (medium, provider_ref, status, failure_code, alert)
       VALUES ('email', $1, 'undelivered', 'HardBounce', 'email-bounced')`,
      [ref],
    );
    const alert = vi.fn();
    await deliverNotification(
      { pool: app, outbound, alert },
      {
        tenantId,
        callId,
        channel: "sms",
        to: TO,
        send: () => Promise.resolve({ providerRef: ref }),
      },
    );
    expect(await statusOf(ref)).toEqual({ status: "sent", failure_code: null });
    expect(alert).not.toHaveBeenCalled();
  });
});
