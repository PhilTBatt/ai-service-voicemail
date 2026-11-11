import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { SIGNATURE_FAILURES_PER_WINDOW } from "../core/spike.ts";
import { createAdminPool, createTenant } from "../db/cross-tenant.ts";
import { startDirectDebit } from "../db/direct-debit.ts";
import { createPool } from "../db/pool.ts";
import { withTenant } from "../db/tenant.ts";
import type { BillingEmailJobData } from "../jobs/billing-email.ts";
import { FakePaymentsProvider } from "../providers/payments.fake.ts";
import type { PaymentsEvent, WebhookHeaders } from "../providers/payments.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import { INVALID_SIGNATURE_STATUS } from "./payments-webhook.ts";

const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);
const payments = new FakePaymentsProvider();
const alert = vi.fn();
const enqueueOnboarding = vi.fn(() => Promise.resolve());
const enqueueBillingEmail = vi.fn((_job: BillingEmailJobData, _client?: unknown) =>
  Promise.resolve(),
);
let post: (rawBody: Buffer, headers: WebhookHeaders) => Promise<Response>;
let stop: () => Promise<void>;

beforeAll(async () => {
  const server = createApp({
    pool: app,
    alert,
    payments: { provider: payments, enqueueOnboarding, enqueueBillingEmail },
  }).listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  post = (rawBody, headers) =>
    fetch(`http://127.0.0.1:${port}/webhooks/gocardless`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(headers as Record<string, string>) },
      body: new Uint8Array(rawBody),
    });
  stop = () => new Promise((resolve) => server.close(() => resolve()));
});

afterAll(async () => {
  await stop();
  await Promise.all([app.end(), admin.end()]);
});

async function businessWithSetup() {
  const tenantId = await createTenant(admin, { businessName: "Hook Plumbing", trade: "plumber" });
  const userId = (
    await admin.query<{ id: string }>(
      "INSERT INTO users (auth_subject, email, role) VALUES ($1, $2, 'owner') RETURNING id",
      [`sub_${randomUUID()}`, `owner-${randomUUID()}@example.com`],
    )
  ).rows[0]!.id;
  await startDirectDebit(app, payments, tenantId, {
    redirectUrl: "https://app.example/done",
    exitUrl: "https://app.example/account",
    actorUserId: userId,
    now: new Date(),
  });
  const setupRef = [...payments.setups.entries()].find(
    ([, setup]) => setup.metadata["tenantId"] === tenantId,
  )![0];
  return { tenantId, setupRef };
}

const event = (
  overrides: Partial<PaymentsEvent> & Pick<PaymentsEvent, "resourceType" | "action">,
) =>
  ({
    id: `EV${randomUUID()}`,
    cause: null,
    description: null,
    links: {},
    createdAt: new Date(),
    ...overrides,
  }) satisfies PaymentsEvent;

describe("POST /webhooks/gocardless", () => {
  it("activates a Direct Debit and later hears it was cancelled, alerting once", async () => {
    const { tenantId, setupRef } = await businessWithSetup();
    alert.mockClear();
    const fulfilled = payments.webhookFor([
      event({
        resourceType: "billing_requests",
        action: "fulfilled",
        links: { billingRequest: setupRef, mandate: "MD_HOOK_1" },
      }),
    ]);
    expect((await post(fulfilled.rawBody, fulfilled.headers)).status).toBe(204);
    // The same delivery again: acknowledged, and nothing happens twice.
    expect((await post(fulfilled.rawBody, fulfilled.headers)).status).toBe(204);
    expect(enqueueOnboarding).toHaveBeenCalledWith(
      { tenantId, action: "go-live" },
      expect.anything(),
    );

    const cancelled = payments.webhookFor([
      event({
        resourceType: "mandates",
        action: "cancelled",
        cause: "mandate_cancelled",
        links: { mandate: "MD_HOOK_1" },
      }),
    ]);
    expect((await post(cancelled.rawBody, cancelled.headers)).status).toBe(204);
    expect((await post(cancelled.rawBody, cancelled.headers)).status).toBe(204);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith("payment-mandate-ended", {
      tenantId,
      status: "cancelled",
      reason: "mandate_cancelled",
    });
    const { rows } = await admin.query(
      "SELECT status, end_reason FROM payment_mandates WHERE tenant_id = $1",
      [tenantId],
    );
    expect(rows).toEqual([{ status: "cancelled", end_reason: "mandate_cancelled" }]);
    // And the business is told, once.
    expect(
      enqueueBillingEmail.mock.calls.filter(([job]) => job.kind === "direct_debit_ended"),
    ).toEqual([[{ tenantId, kind: "direct_debit_ended", ref: "MD_HOOK_1" }, expect.anything()]]);
  });

  it("follows a payment forward only, and on a failure alerts and tells the business", async () => {
    const tenantId = await createTenant(admin, {
      businessName: "Paying Plumbing",
      trade: "plumber",
    });
    const paymentRef = `PM${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const chargeId = await withTenant(
      app,
      tenantId,
      async (client) =>
        (
          await client.query<{ id: string }>(
            `INSERT INTO billing_charges (tenant_id, period_start, period_end, period_index,
               billable_seconds, fee_pence, overage_minutes, overage_pence, vat_rate_percent,
               vat_pence, total_pence, lines, status, payment_ref)
             VALUES ($1, '2026-06-14', '2026-07-14', 0, 0, 9900, 0, 0, 0, 0, 9900, '[]', 'pending', $2)
             RETURNING id`,
            [tenantId, paymentRef],
          )
        ).rows[0]!.id,
    );
    const status = async () =>
      (
        await admin.query<{ status: string; failure_reason: string | null }>(
          "SELECT status, failure_reason FROM billing_charges WHERE id = $1",
          [chargeId],
        )
      ).rows[0];
    const send = async (action: string, cause: string | null = null) => {
      const { rawBody, headers } = payments.webhookFor([
        event({ resourceType: "payments", action, cause, links: { payment: paymentRef } }),
      ]);
      expect((await post(rawBody, headers)).status).toBe(204);
    };

    await send("submitted");
    await send("paid_out");
    // Arriving late, out of order: ignored, it never goes backwards.
    await send("confirmed");
    expect(await status()).toEqual({ status: "paid_out", failure_reason: null });

    alert.mockClear();
    enqueueBillingEmail.mockClear();
    // A charge-back after it was paid out wins.
    await send("charged_back", "refund_requested");
    expect(await status()).toEqual({ status: "charged_back", failure_reason: "refund_requested" });
    expect(alert).toHaveBeenCalledWith("billing-payment-failed", {
      tenantId,
      periodStart: "2026-06-14",
      status: "charged_back",
      reason: "refund_requested",
    });
    expect(enqueueBillingEmail).toHaveBeenCalledWith(
      { tenantId, kind: "payment_failed", ref: chargeId },
      expect.anything(),
    );
    // BUILD_PLAN Step 12: a failed payment does not suspend the business.
    const { rows } = await admin.query("SELECT status FROM tenants WHERE id = $1", [tenantId]);
    expect(rows).toEqual([{ status: "onboarding" }]);

    // Collected again from the GoCardless dashboard: same payment, starting over. It ends up
    // shown as paid, and a later failure is said again.
    await send("resubmission_requested");
    await send("submitted");
    await send("paid_out");
    expect(await status()).toEqual({ status: "paid_out", failure_reason: null });
    alert.mockClear();
    await send("failed", "insufficient_funds");
    expect(alert).toHaveBeenCalledWith(
      "billing-payment-failed",
      expect.objectContaining({ tenantId, status: "failed", reason: "insufficient_funds" }),
    );
  });

  it("follows a mandate that's replaced, and one reinstated after it ended", async () => {
    const { tenantId, setupRef } = await businessWithSetup();
    const deliver = async (e: PaymentsEvent) => {
      const { rawBody, headers } = payments.webhookFor([e]);
      expect((await post(rawBody, headers)).status).toBe(204);
    };
    const mandates = async () =>
      (
        await admin.query<{ mandate_ref: string; status: string }>(
          "SELECT mandate_ref, status FROM payment_mandates WHERE tenant_id = $1",
          [tenantId],
        )
      ).rows;
    await deliver(
      event({
        resourceType: "billing_requests",
        action: "fulfilled",
        links: { billingRequest: setupRef, mandate: "MD_OLD_SCHEME" },
      }),
    );
    await deliver(
      event({
        resourceType: "mandates",
        action: "replaced",
        links: { mandate: "MD_OLD_SCHEME", newMandate: "MD_NEW_SCHEME" },
      }),
    );
    expect(await mandates()).toEqual([{ mandate_ref: "MD_NEW_SCHEME", status: "active" }]);

    await deliver(
      event({ resourceType: "mandates", action: "cancelled", links: { mandate: "MD_NEW_SCHEME" } }),
    );
    await deliver(
      event({
        resourceType: "mandates",
        action: "reinstated",
        links: { mandate: "MD_NEW_SCHEME" },
      }),
    );
    expect(await mandates()).toEqual([{ mandate_ref: "MD_NEW_SCHEME", status: "active" }]);
  });

  it("acknowledges events about things it doesn't know, so the provider stops sending them", async () => {
    const unknown = payments.webhookFor([
      event({ resourceType: "payouts" as never, action: "paid" }),
      event({ resourceType: "mandates", action: "cancelled", links: { mandate: "MD_NOBODY" } }),
    ]);
    expect((await post(unknown.rawBody, unknown.headers)).status).toBe(204);
  });

  it("answers a bad signature with 498, changes nothing, and alerts on a run of them", async () => {
    const { tenantId, setupRef } = await businessWithSetup();
    alert.mockClear();
    const forged = payments.webhookFor([
      event({
        resourceType: "billing_requests",
        action: "fulfilled",
        links: { billingRequest: setupRef, mandate: "MD_FORGED" },
      }),
    ]);
    for (let i = 0; i <= SIGNATURE_FAILURES_PER_WINDOW; i++) {
      const response = await post(forged.rawBody, { "webhook-signature": "0".repeat(64) });
      expect(response.status).toBe(INVALID_SIGNATURE_STATUS);
    }
    const { rows } = await admin.query("SELECT status FROM payment_mandates WHERE tenant_id = $1", [
      tenantId,
    ]);
    expect(rows).toEqual([{ status: "pending" }]);
    expect(alert).toHaveBeenCalledWith("webhook-signature-spike", {
      source: "gocardless",
      inWindow: SIGNATURE_FAILURES_PER_WINDOW + 1,
    });
  });
});
