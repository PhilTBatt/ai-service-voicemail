// POST /webhooks/gocardless at its edges, over HTTP with the real GoCardless signature check
// (a fictional secret; nothing leaves the machine): signatures that are missing, forged, for
// another body or other bytes; bodies that are signed but malformed or too big; the same
// delivery replayed; and a batch that fails part-way and is sent again, as GoCardless does
// for anything but a 2xx. Real Postgres underneath.
import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { createAdminPool, createTenant } from "../db/cross-tenant.ts";
import { createPool } from "../db/pool.ts";
import { withTenant } from "../db/tenant.ts";
import type { BillingEmailJobData } from "../jobs/billing-email.ts";
import { GoCardlessPaymentsProvider } from "../providers/gocardless.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import { INVALID_SIGNATURE_STATUS } from "./payments-webhook.ts";

const SECRET = "whsec_fictional_for_tests";
const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);
const provider = new GoCardlessPaymentsProvider({
  accessToken: "fictional_token",
  environment: "sandbox",
  webhookSecret: SECRET,
  // A webhook never calls the API; if anything tries, the test fails loudly.
  fetch: () => Promise.reject(new Error("No network in tests")),
});
const alert = vi.fn();
const enqueueBillingEmail = vi.fn((_job: BillingEmailJobData, _client?: unknown) =>
  Promise.resolve(),
);
let base = "";
let stop: () => Promise<void>;

beforeAll(async () => {
  const server = createApp({
    pool: app,
    alert,
    payments: { provider, enqueueBillingEmail },
  }).listen(0);
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhooks/gocardless`;
  stop = () => new Promise((resolve) => server.close(() => resolve()));
});

afterAll(async () => {
  await stop();
  await Promise.all([app.end(), admin.end()]);
});

beforeEach(() => {
  alert.mockClear();
  enqueueBillingEmail.mockClear();
});

const sign = (body: Buffer | string, key = SECRET) =>
  createHmac("sha256", key).update(body).digest("hex");

const post = (body: Buffer | string, headers: Record<string, string> = {}) =>
  fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : new Uint8Array(body),
  });

const signedPost = (body: string) => post(body, { "webhook-signature": sign(body) });

interface WireEvent {
  id: string;
  created_at: string;
  resource_type: string;
  action: string;
  details?: { cause?: string };
  links: Record<string, string>;
}

const paymentEvent = (payment: string, action: string, cause?: string): WireEvent => ({
  id: `EV${randomUUID()}`,
  created_at: "2026-10-15T09:00:00.000Z",
  resource_type: "payments",
  action,
  ...(cause !== undefined && { details: { cause } }),
  links: { payment },
});

const body = (...events: WireEvent[]) => JSON.stringify({ events });

async function chargedBusiness() {
  const tenantId = await createTenant(admin, { businessName: "Edge Plumbing", trade: "plumber" });
  const paymentRef = `PM${randomUUID().replace(/-/g, "").slice(0, 14)}`;
  const chargeId = await withTenant(
    app,
    tenantId,
    async (client) =>
      (
        await client.query<{ id: string }>(
          `INSERT INTO billing_charges (tenant_id, period_start, period_end, period_index,
             billable_seconds, fee_pence, overage_minutes, overage_pence, vat_rate_percent,
             vat_pence, total_pence, lines, status, payment_ref)
           VALUES ($1, '2026-09-14', '2026-10-14', 3, 0, 9900, 0, 0, 0, 0, 9900, '[]', 'pending', $2)
           RETURNING id`,
          [tenantId, paymentRef],
        )
      ).rows[0]!.id,
  );
  return { tenantId, paymentRef, chargeId };
}

const status = async (chargeId: string) =>
  (
    await admin.query<{ status: string }>("SELECT status FROM billing_charges WHERE id = $1", [
      chargeId,
    ])
  ).rows[0]?.status;

const recordedEvents = async (ids: string[]) =>
  (
    await admin.query<{ event_id: string }>(
      "SELECT event_id FROM payment_events WHERE event_id = ANY($1)",
      [ids],
    )
  ).rows.map((row) => row.event_id);

describe("signatures", () => {
  it("acts on a correctly signed delivery, whatever case the header's name is in", async () => {
    const { paymentRef, chargeId } = await chargedBusiness();
    const delivery = body(paymentEvent(paymentRef, "confirmed"));
    const response = await post(delivery, { "Webhook-Signature": sign(delivery) });
    expect(response.status).toBe(204);
    expect(await status(chargeId)).toBe("confirmed");
  });

  it.each([
    ["no signature", () => ({})],
    ["an empty one", () => ({ "webhook-signature": "" })],
    ["one made with another key", (b: string) => ({ "webhook-signature": sign(b, "whsec_other") })],
    ["one for another body", () => ({ "webhook-signature": sign('{"events":[]}') })],
    ["one cut short", (b: string) => ({ "webhook-signature": sign(b).slice(0, 63) })],
    ["one with a byte added", (b: string) => ({ "webhook-signature": `${sign(b)}0` })],
    ["one in capitals", (b: string) => ({ "webhook-signature": sign(b).toUpperCase() })],
    ["the secret itself", () => ({ "webhook-signature": SECRET })],
  ])("answers %s with 498 and changes nothing", async (_name, headers) => {
    const { paymentRef, chargeId } = await chargedBusiness();
    const event = paymentEvent(paymentRef, "failed", "insufficient_funds");
    const delivery = body(event);
    const response = await post(delivery, headers(delivery));
    expect(response.status).toBe(INVALID_SIGNATURE_STATUS);
    expect(await status(chargeId)).toBe("pending");
    expect(await recordedEvents([event.id])).toEqual([]);
    expect(enqueueBillingEmail).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalledWith("billing-payment-failed", expect.anything());
  });

  it("refuses a body changed by a single byte after it was signed", async () => {
    const { paymentRef, chargeId } = await chargedBusiness();
    const delivery = body(paymentEvent(paymentRef, "failed"));
    const tampered = delivery.replace('"failed"', '"failed" ');
    expect((await post(tampered, { "webhook-signature": sign(delivery) })).status).toBe(
      INVALID_SIGNATURE_STATUS,
    );
    expect(await status(chargeId)).toBe("pending");
  });
});

describe("signed but unusable bodies", () => {
  it.each([
    ["an empty body", ""],
    ["a body that isn't JSON", "events=1"],
    ["JSON with no events", '{"event":[]}'],
    [
      "an event missing its ID",
      '{"events":[{"created_at":"x","resource_type":"payments","action":"failed"}]}',
    ],
    ["events that aren't a list", '{"events":{"id":"EV1"}}'],
  ])("answers %s with 498, as nothing GoCardless sends again would fix", async (_name, raw) => {
    expect((await signedPost(raw)).status).toBe(INVALID_SIGNATURE_STATUS);
  });

  it("refuses a body over 1 MB before reading it as events", async () => {
    const huge = JSON.stringify({ events: [], padding: "x".repeat(1_100_000) });
    const response = await signedPost(huge);
    expect(response.status).toBe(413);
  });

  it("verifies a delivery sent with any content type, since the signature covers the bytes", async () => {
    const { paymentRef, chargeId } = await chargedBusiness();
    const delivery = body(paymentEvent(paymentRef, "submitted"));
    const response = await post(delivery, {
      "content-type": "text/plain",
      "webhook-signature": sign(delivery),
    });
    expect(response.status).toBe(204);
    expect(await status(chargeId)).toBe("submitted");
  });

  it("acknowledges an empty batch", async () => {
    expect((await signedPost(body())).status).toBe(204);
  });
});

describe("repeats and failures part-way", () => {
  it("handles a replayed delivery once, however many times it comes", async () => {
    const { tenantId, paymentRef, chargeId } = await chargedBusiness();
    const delivery = body(paymentEvent(paymentRef, "failed", "insufficient_funds"));
    for (let i = 0; i < 4; i++) expect((await signedPost(delivery)).status).toBe(204);
    expect(await status(chargeId)).toBe("failed");
    expect(enqueueBillingEmail).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls.filter(([name]) => name === "billing-payment-failed")).toEqual([
      [
        "billing-payment-failed",
        { tenantId, periodStart: "2026-09-14", status: "failed", reason: "insufficient_funds" },
      ],
    ]);
  });

  it("handles an event that appears twice in one batch once", async () => {
    const { paymentRef } = await chargedBusiness();
    const event = paymentEvent(paymentRef, "failed");
    expect((await signedPost(body(event, event))).status).toBe(204);
    expect(enqueueBillingEmail).toHaveBeenCalledTimes(1);
  });

  it("answers 500 when a batch fails part-way, and on the provider's retry finishes it without repeating the first part", async () => {
    const first = await chargedBusiness();
    const second = await chargedBusiness();
    const events = [
      paymentEvent(first.paymentRef, "failed", "insufficient_funds"),
      paymentEvent(second.paymentRef, "failed", "insufficient_funds"),
    ];
    const delivery = body(...events);
    // The first event's email queues; the second's doesn't, so its transaction rolls back.
    enqueueBillingEmail.mockImplementationOnce(() => Promise.resolve());
    enqueueBillingEmail.mockImplementationOnce(() =>
      Promise.reject(new Error("The queue is unavailable")),
    );
    expect((await signedPost(delivery)).status).toBe(500);
    expect(await status(first.chargeId)).toBe("failed");
    expect(await status(second.chargeId)).toBe("pending");
    expect(await recordedEvents(events.map((e) => e.id))).toEqual([events[0]!.id]);

    expect((await signedPost(delivery)).status).toBe(204);
    expect(await status(second.chargeId)).toBe("failed");
    // Each business told once, each alerted once, across both deliveries.
    expect(enqueueBillingEmail.mock.calls.map(([job]) => job.tenantId)).toEqual([
      first.tenantId,
      second.tenantId,
      second.tenantId,
    ]);
    expect(
      alert.mock.calls
        .filter(([name]) => name === "billing-payment-failed")
        .map(([, details]) => (details as { tenantId: string }).tenantId),
    ).toEqual([first.tenantId, second.tenantId]);
  });

  it("acknowledges events for payments and mandates nobody here has, recording nothing", async () => {
    const events = [
      paymentEvent("PM_NOBODY_HERE", "failed"),
      {
        ...paymentEvent("x", "cancelled"),
        resource_type: "mandates",
        links: { mandate: "MD_NOBODY" },
      },
      { ...paymentEvent("x", "paid"), resource_type: "payouts", links: { payout: "PO_NOBODY" } },
    ];
    expect((await signedPost(body(...events))).status).toBe(204);
    expect(await recordedEvents(events.map((e) => e.id))).toEqual([]);
    expect(enqueueBillingEmail).not.toHaveBeenCalled();
  });
});
