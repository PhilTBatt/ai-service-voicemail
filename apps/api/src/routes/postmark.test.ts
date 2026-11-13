import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { createAdminPool, createTenant } from "../db/cross-tenant.ts";
import { createPool } from "../db/pool.ts";
import { withTenant } from "../db/tenant.ts";
import { runBillingEmail } from "../jobs/billing-email.ts";
import { deliverNotification } from "../jobs/deliver-notification.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";

const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);
const SECRET = "webhook-secret-for-tests";
const alert = vi.fn();
let post: (body: unknown, auth?: string) => Promise<Response>;
let stop: () => Promise<void>;

beforeAll(async () => {
  const server = createApp({ pool: app, postmark: { webhookSecret: SECRET, alert } }).listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  post = (body, auth = `Basic ${Buffer.from(`postmark:${SECRET}`).toString("base64")}`) =>
    fetch(`http://127.0.0.1:${port}/webhooks/postmark`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth },
      body: JSON.stringify(body),
    });
  stop = () => new Promise((resolve) => server.close(() => resolve()));
});

afterAll(async () => {
  await stop();
  await Promise.all([app.end(), admin.end()]);
});

/** A tenant with one call and a sent email, as notify-email leaves them. */
async function makeSentEmail() {
  const tenantId = await createTenant(admin, { businessName: "Bounce Plumbing", trade: "plumber" });
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO calls (tenant_id, provider_call_id, started_at, ended_at, summary)
     VALUES ($1, $2, now(), now(), 'A job.') RETURNING id`,
    [tenantId, `call_${randomUUID()}`],
  );
  const messageId = randomUUID();
  await admin.query(
    `INSERT INTO notifications (tenant_id, call_id, channel, status, attempts, provider_ref)
     VALUES ($1, $2, 'email', 'sent', 1, $3)`,
    [tenantId, rows[0]!.id, messageId],
  );
  return { tenantId, callId: rows[0]!.id, messageId };
}
const row = async (messageId: string) =>
  (
    await admin.query<{ status: string; failure_code: string | null }>(
      "SELECT status, failure_code FROM notifications WHERE provider_ref = $1",
      [messageId],
    )
  ).rows[0];

describe("POST /webhooks/postmark", () => {
  it("marks a hard-bounced email undelivered and alerts", async () => {
    alert.mockClear();
    const { tenantId, callId, messageId } = await makeSentEmail();
    const response = await post({
      RecordType: "Bounce",
      Type: "HardBounce",
      TypeCode: 1,
      MessageID: messageId,
      Email: "sam@example.com",
      Inactive: true,
    });
    expect(response.status).toBe(200);
    expect(await row(messageId)).toEqual({ status: "undelivered", failure_code: "HardBounce" });
    expect(alert).toHaveBeenCalledWith("email-bounced", {
      tenantId,
      callId,
      type: "HardBounce",
      addressDeactivated: true,
    });
  });

  it("treats a spam complaint as final and names it", async () => {
    alert.mockClear();
    const { messageId } = await makeSentEmail();
    await post({ RecordType: "SpamComplaint", Type: "SpamComplaint", MessageID: messageId });
    expect((await row(messageId))?.status).toBe("undelivered");
    expect(alert).toHaveBeenCalledWith(
      "email-spam-complaint",
      expect.objectContaining({ type: "SpamComplaint" }),
    );
  });

  it("applies a bounce that arrives before the send job has saved the email's ID, alerting once", async () => {
    const tenantId = await createTenant(admin, { businessName: "Quick Bounce", trade: "plumber" });
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO calls (tenant_id, provider_call_id, started_at, ended_at, summary)
       VALUES ($1, $2, now(), now(), 'A job.') RETURNING id`,
      [tenantId, `call_${randomUUID()}`],
    );
    const callId = rows[0]!.id;
    const messageId = randomUUID();
    const bounce = { RecordType: "Bounce", Type: "HardBounce", MessageID: messageId };
    const to = "sam@example.com";
    alert.mockClear();
    const outcome = await deliverNotification(
      { pool: app, outbound: { nodeEnv: "test", allowlist: new Set([to]) }, alert },
      {
        tenantId,
        callId,
        channel: "email",
        to,
        // Postmark reports the bounce before our record of the send has its ID.
        send: async () => {
          expect((await post(bounce)).status).toBe(200);
          return { providerRef: messageId };
        },
      },
    );
    expect(outcome).toBe("sent");
    expect(await row(messageId)).toEqual({ status: "undelivered", failure_code: "HardBounce" });
    expect(alert.mock.calls).toEqual([
      ["email-bounced", { tenantId, callId, type: "HardBounce", addressDeactivated: false }],
    ]);
    // Postmark sending it again (it retries a webhook that failed) tells nobody twice.
    await post(bounce);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("ignores a transient bounce, unknown messages and other record types", async () => {
    const { messageId } = await makeSentEmail();
    expect(
      (await post({ RecordType: "Bounce", Type: "Transient", MessageID: messageId })).status,
    ).toBe(200);
    expect((await row(messageId))?.status).toBe("sent");
    expect(
      (await post({ RecordType: "Bounce", Type: "HardBounce", MessageID: "unknown" })).status,
    ).toBe(200);
    expect((await post({ RecordType: "Delivery", MessageID: messageId })).status).toBe(200);
  });

  // The emails that aren't about a call: these were "an email we don't know" until 2026-11-11,
  // so a bounce told nobody.
  describe("for the business's other emails", () => {
    const ADDRESS = "accounts@example.com";
    const alertsFor = (tenantId: string) =>
      alert.mock.calls.filter(
        ([, details]) => (details as { tenantId?: string }).tenantId === tenantId,
      );
    const business = () =>
      createTenant(admin, {
        businessName: "Ledger Plumbing",
        trade: "plumber",
        notificationEmail: ADDRESS,
      });
    const billingEmail = async (messageId: string) =>
      (
        await admin.query<{
          status: string;
          delivery_status: string | null;
          failure_code: string | null;
        }>(
          "SELECT status, delivery_status, failure_code FROM billing_emails WHERE provider_ref = $1",
          [messageId],
        )
      ).rows[0];

    it("marks a hard-bounced billing email undelivered and alerts once, saying which email", async () => {
      const tenantId = await business();
      const messageId = randomUUID();
      await withTenant(app, tenantId, (client) =>
        client.query(
          `INSERT INTO billing_emails (tenant_id, kind, ref, status, provider_ref)
           VALUES ($1, 'payment_failed', $2, 'sent', $3)`,
          [tenantId, `charge_${randomUUID()}`, messageId],
        ),
      );
      const bounce = {
        RecordType: "Bounce",
        Type: "HardBounce",
        TypeCode: 1,
        MessageID: messageId,
        Email: ADDRESS,
        Inactive: true,
      };
      expect((await post(bounce)).status).toBe(200);
      // Postmark sends a webhook again when it thinks the first failed.
      expect((await post(bounce)).status).toBe(200);

      // Still 'sent' (the job reads the row to send each email once), with Postmark's verdict.
      expect(await billingEmail(messageId)).toEqual({
        status: "sent",
        delivery_status: "undelivered",
        failure_code: "HardBounce",
      });
      expect(alertsFor(tenantId)).toEqual([
        [
          "email-bounced",
          {
            tenantId,
            messageKind: "billing email: payment failed",
            type: "HardBounce",
            addressDeactivated: true,
          },
        ],
      ]);
    });

    it("applies a bounce that arrives before the billing email's ID is saved, alerting once", async () => {
      const tenantId = await business();
      const messageId = randomUUID();
      const bounce = { RecordType: "Bounce", Type: "HardBounce", MessageID: messageId };
      // Postmark reports the bounce before our record of the send has its ID.
      const email = {
        send: async () => {
          expect((await post(bounce)).status).toBe(200);
          return { providerRef: messageId };
        },
      };
      expect(
        await runBillingEmail(
          {
            pool: app,
            email,
            outbound: { nodeEnv: "test", allowlist: new Set([ADDRESS]) },
            dashboardOrigin: "https://app.example.com",
            alert,
          },
          { tenantId, kind: "direct_debit_ended", ref: `MD${randomUUID()}` },
        ),
      ).toBe("sent");
      expect(await billingEmail(messageId)).toEqual({
        status: "sent",
        delivery_status: "undelivered",
        failure_code: "HardBounce",
      });
      await post(bounce);
      expect(alertsFor(tenantId)).toEqual([
        [
          "email-bounced",
          {
            tenantId,
            messageKind: "billing email: direct debit ended",
            type: "HardBounce",
            addressDeactivated: false,
          },
        ],
      ]);
    });

    it("records a bounced deletion confirmation beside it in the audit log, and alerts once", async () => {
      const tenantId = await business();
      const messageId = randomUUID();
      // As the deletion leaves the business: the confirmation in the audit log, the rest gone.
      await withTenant(app, tenantId, (client) =>
        client.query(
          "INSERT INTO audit_log (tenant_id, action, details) VALUES ($1, 'tenant.deletion-confirmed', $2)",
          [tenantId, { sentBy: "email", providerRef: messageId }],
        ),
      );
      await admin.query(
        `UPDATE tenants SET business_name = 'Deleted business', notification_email = NULL,
                status = 'cancelled', data_deleted_at = now() WHERE id = $1`,
        [tenantId],
      );
      const bounce = { RecordType: "Bounce", Type: "HardBounce", MessageID: messageId };
      expect((await post(bounce)).status).toBe(200);
      expect((await post(bounce)).status).toBe(200);

      const { rows } = await admin.query(
        `SELECT action, details FROM audit_log
         WHERE tenant_id = $1 AND action LIKE 'tenant.deletion-confirmation-%'`,
        [tenantId],
      );
      expect(rows).toEqual([
        {
          action: "tenant.deletion-confirmation-undelivered",
          details: { providerRef: messageId, failureCode: "HardBounce" },
        },
      ]);
      expect(alertsFor(tenantId)).toEqual([
        [
          "email-bounced",
          {
            tenantId,
            messageKind: "deletion confirmation email",
            type: "HardBounce",
            addressDeactivated: false,
          },
        ],
      ]);
    });

    it("names a spam complaint about a cancellation email", async () => {
      const tenantId = await business();
      const messageId = randomUUID();
      await withTenant(app, tenantId, (client) =>
        client.query(
          `INSERT INTO offboarding_messages (tenant_id, kind, channel, status, provider_ref)
           VALUES ($1, 'cancellation', 'email', 'sent', $2)`,
          [tenantId, messageId],
        ),
      );
      await post({ RecordType: "SpamComplaint", Type: "SpamComplaint", MessageID: messageId });
      expect(alertsFor(tenantId)).toEqual([
        [
          "email-spam-complaint",
          {
            tenantId,
            messageKind: "cancellation email",
            type: "SpamComplaint",
            addressDeactivated: false,
          },
        ],
      ]);
    });
  });

  it("rejects a request without the right Basic auth", async () => {
    const { messageId, callId } = await makeSentEmail();
    const body = { RecordType: "Bounce", Type: "HardBounce", MessageID: messageId };
    expect((await post(body, "")).status).toBe(401);
    expect(
      (await post(body, `Basic ${Buffer.from("postmark:wrong").toString("base64")}`)).status,
    ).toBe(401);
    // The right number of characters but more bytes (é is two in UTF-8): still a plain 401,
    // not a crash in the constant-time comparison.
    const right = `Basic ${Buffer.from(`postmark:${SECRET}`).toString("base64")}`;
    expect((await post(body, `Basic ${"é".repeat(right.length - "Basic ".length)}`)).status).toBe(
      401,
    );
    // The right password under another user name, the secret alone, or as a bearer token.
    for (const wrong of [
      `Basic ${Buffer.from(`admin:${SECRET}`).toString("base64")}`,
      `Basic ${Buffer.from(SECRET).toString("base64")}`,
      `Bearer ${SECRET}`,
    ]) {
      const response = await post(body, wrong);
      expect(response.status, wrong).toBe(401);
      expect(await response.json()).toEqual({ error: "Unauthorized" });
    }
    expect((await row(messageId))?.status).toBe("sent");
    // A forged bounce raises nothing: no alert names a business or a call.
    expect(alert).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ callId }));
  });
});
