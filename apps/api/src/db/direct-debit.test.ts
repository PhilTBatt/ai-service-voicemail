import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { FakePaymentsProvider } from "../providers/payments.fake.ts";
import type { PaymentsEvent } from "../providers/payments.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import { createAdminPool, createTenant } from "./cross-tenant.ts";
import {
  checkDirectDebit,
  directDebitState,
  handlePaymentsEvent,
  startDirectDebit,
} from "./direct-debit.ts";
import { onboardingStatus } from "./onboarding.ts";
import { createPool } from "./pool.ts";
import { withTenant } from "./tenant.ts";

const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);

afterAll(async () => {
  await Promise.all([app.end(), admin.end()]);
});

const NOW = new Date("2026-11-10T12:00:00Z");
const urls = { redirectUrl: "https://app.example/done", exitUrl: "https://app.example/account" };

async function business() {
  const tenantId = await createTenant(admin, {
    businessName: "Wren Plumbing",
    trade: "plumber",
    notificationEmail: "wren@example.com",
  });
  const userId = (
    await admin.query<{ id: string }>(
      "INSERT INTO users (auth_subject, email, role) VALUES ($1, $2, 'owner') RETURNING id",
      [`sub_${randomUUID()}`, `owner-${randomUUID()}@example.com`],
    )
  ).rows[0]!.id;
  return { tenantId, userId };
}

const state = (tenantId: string) =>
  withTenant(app, tenantId, (client) => directDebitState(client, tenantId));

const event = (
  overrides: Partial<PaymentsEvent> & Pick<PaymentsEvent, "resourceType" | "action">,
) =>
  ({
    id: `EV${randomUUID()}`,
    cause: null,
    description: null,
    links: {},
    createdAt: NOW,
    ...overrides,
  }) satisfies PaymentsEvent;

describe("starting a Direct Debit", () => {
  it("makes a set-up at the provider with the business's name and email, and reuses it", async () => {
    const { tenantId, userId } = await business();
    const payments = new FakePaymentsProvider();
    const first = await startDirectDebit(app, payments, tenantId, {
      ...urls,
      actorUserId: userId,
      now: NOW,
    });
    expect(first).toMatchObject({ outcome: "started" });
    expect([...payments.setups.values()]).toEqual([
      expect.objectContaining({
        businessName: "Wren Plumbing",
        email: "wren@example.com",
        redirectUrl: urls.redirectUrl,
        metadata: { tenantId },
        status: "pending",
      }),
    ]);
    expect(await state(tenantId)).toEqual({ status: "pending", since: null, endReason: null });

    // A second click hands back the same link: one set-up, not two.
    const second = await startDirectDebit(app, payments, tenantId, {
      ...urls,
      actorUserId: userId,
      now: NOW,
    });
    expect(second).toEqual(first);
    expect(payments.setups.size).toBe(1);
  });

  it("refuses a business that already has one, and a cancelled business", async () => {
    const { tenantId, userId } = await business();
    const payments = new FakePaymentsProvider();
    await startDirectDebit(app, payments, tenantId, { ...urls, actorUserId: userId, now: NOW });
    payments.completeSetup([...payments.setups.keys()][0]!);
    await checkDirectDebit(app, payments, tenantId);
    expect(
      await startDirectDebit(app, payments, tenantId, { ...urls, actorUserId: userId, now: NOW }),
    ).toEqual({ outcome: "already-active" });

    const gone = await business();
    await admin.query("UPDATE tenants SET status = 'cancelled' WHERE id = $1", [gone.tenantId]);
    expect(
      await startDirectDebit(app, payments, gone.tenantId, {
        ...urls,
        actorUserId: gone.userId,
        now: NOW,
      }),
    ).toEqual({ outcome: "not-allowed", status: "cancelled" });
  });
});

describe("when the person comes back", () => {
  it("records the mandate, counts payment as ready, and queues a go-live check", async () => {
    const { tenantId, userId } = await business();
    const payments = new FakePaymentsProvider();
    const enqueueOnboarding = vi.fn(() => Promise.resolve());
    await startDirectDebit(app, payments, tenantId, { ...urls, actorUserId: userId, now: NOW });

    // Not finished yet: still pending, nothing queued.
    expect(await checkDirectDebit(app, payments, tenantId, enqueueOnboarding)).toMatchObject({
      status: "pending",
    });
    expect(enqueueOnboarding).not.toHaveBeenCalled();

    const setupRef = [...payments.setups.keys()][0]!;
    const mandateRef = payments.completeSetup(setupRef);
    expect(await checkDirectDebit(app, payments, tenantId, enqueueOnboarding)).toMatchObject({
      status: "active",
      since: expect.any(Date) as Date,
    });
    expect(enqueueOnboarding).toHaveBeenCalledTimes(1);
    expect(enqueueOnboarding).toHaveBeenCalledWith(
      { tenantId, action: "go-live" },
      expect.anything(),
    );
    const { rows } = await admin.query(
      "SELECT mandate_ref FROM payment_mandates WHERE tenant_id = $1",
      [tenantId],
    );
    expect(rows).toEqual([{ mandate_ref: mandateRef }]);

    // Onboarding sees it.
    const checklist = await onboardingStatus(app, tenantId);
    expect(checklist?.checks).toContainEqual({ label: "Direct Debit set up", ok: true });

    // Checking again changes nothing and queues nothing more.
    await checkDirectDebit(app, payments, tenantId, enqueueOnboarding);
    expect(enqueueOnboarding).toHaveBeenCalledTimes(1);
  });

  it("forgets a set-up the person gave up on", async () => {
    const { tenantId, userId } = await business();
    const payments = new FakePaymentsProvider();
    await startDirectDebit(app, payments, tenantId, { ...urls, actorUserId: userId, now: NOW });
    payments.cancelSetup([...payments.setups.keys()][0]!);
    expect(await checkDirectDebit(app, payments, tenantId)).toEqual({
      status: "none",
      since: null,
      endReason: null,
    });
  });
});

describe("the provider's events", () => {
  async function businessWithSetup() {
    const { tenantId, userId } = await business();
    const payments = new FakePaymentsProvider();
    await startDirectDebit(app, payments, tenantId, { ...urls, actorUserId: userId, now: NOW });
    const setupRef = [...payments.setups.keys()][0]!;
    return { tenantId, setupRef, payments };
  }

  it("activates the mandate when the set-up is fulfilled, once however often it's sent", async () => {
    const { tenantId, setupRef } = await businessWithSetup();
    const enqueueOnboarding = vi.fn(() => Promise.resolve());
    const fulfilled = event({
      resourceType: "billing_requests",
      action: "fulfilled",
      links: { billingRequest: setupRef, mandate: "MD_FROM_WEBHOOK" },
    });
    expect(await handlePaymentsEvent(app, fulfilled, { enqueueOnboarding })).toEqual({
      outcome: "handled",
      tenantId,
    });
    expect(await handlePaymentsEvent(app, fulfilled, { enqueueOnboarding })).toEqual({
      outcome: "duplicate",
      tenantId,
    });
    expect(await state(tenantId)).toMatchObject({ status: "active" });
    expect(enqueueOnboarding).toHaveBeenCalledTimes(1);
    const { rows } = await admin.query(
      "SELECT resource_type, action, resource_ref FROM payment_events WHERE tenant_id = $1",
      [tenantId],
    );
    expect(rows).toEqual([
      { resource_type: "billing_requests", action: "fulfilled", resource_ref: setupRef },
    ]);
  });

  it("ends an active mandate the bank cancelled, and says so", async () => {
    const { tenantId, setupRef } = await businessWithSetup();
    await handlePaymentsEvent(
      app,
      event({
        resourceType: "billing_requests",
        action: "fulfilled",
        links: { billingRequest: setupRef, mandate: "MD_TO_CANCEL" },
      }),
    );
    const cancelled = event({
      resourceType: "mandates",
      action: "cancelled",
      cause: "bank_account_closed",
      links: { mandate: "MD_TO_CANCEL" },
    });
    expect(await handlePaymentsEvent(app, cancelled)).toEqual({
      outcome: "handled",
      tenantId,
      mandateEnded: { status: "cancelled", reason: "bank_account_closed" },
    });
    expect(await state(tenantId)).toEqual({
      status: "ended",
      since: expect.any(Date) as Date,
      endReason: "bank_account_closed",
    });
    const checklist = await onboardingStatus(app, tenantId);
    expect(checklist?.checks).toContainEqual({ label: "Direct Debit set up", ok: false });
  });

  it("acknowledges what it doesn't know, and events it has nothing to do for", async () => {
    expect(
      await handlePaymentsEvent(
        app,
        event({ resourceType: "mandates", action: "cancelled", links: { mandate: "MD_NOBODY" } }),
      ),
    ).toEqual({ outcome: "unknown" });
    const { tenantId, setupRef } = await businessWithSetup();
    expect(
      await handlePaymentsEvent(
        app,
        event({
          resourceType: "billing_requests",
          action: "flow_visited",
          links: { billingRequest: setupRef },
        }),
      ),
    ).toEqual({ outcome: "ignored", tenantId });
  });
});
