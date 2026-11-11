import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { SIGNATURE_FAILURES_PER_WINDOW } from "../core/spike.ts";
import { createAdminPool, createTenant } from "../db/cross-tenant.ts";
import { startDirectDebit } from "../db/direct-debit.ts";
import { createPool } from "../db/pool.ts";
import { FakePaymentsProvider } from "../providers/payments.fake.ts";
import type { PaymentsEvent, WebhookHeaders } from "../providers/payments.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import { INVALID_SIGNATURE_STATUS } from "./payments-webhook.ts";

const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);
const payments = new FakePaymentsProvider();
const alert = vi.fn();
const enqueueOnboarding = vi.fn(() => Promise.resolve());
let post: (rawBody: Buffer, headers: WebhookHeaders) => Promise<Response>;
let stop: () => Promise<void>;

beforeAll(async () => {
  const server = createApp({
    pool: app,
    alert,
    payments: { provider: payments, enqueueOnboarding },
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
