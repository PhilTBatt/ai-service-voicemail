// The payments provider's events in every order they can arrive (GoCardless says events can
// come out of order, and are redelivered until answered): a month's charge only ever moves
// forward, a failure is told once, a repeat changes nothing, and an event never touches
// another business. Real Postgres; events go straight to handlePaymentsEvent, as the webhook
// route hands them over.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { BillingEmailJobData } from "../jobs/billing-email.ts";
import { FakePaymentsProvider } from "../providers/payments.fake.ts";
import type { PaymentsEvent } from "../providers/payments.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import { collectAgain } from "./billing-actions.ts";
import { createAdminPool, createTenant } from "./cross-tenant.ts";
import { handlePaymentsEvent, type EventOutcome } from "./direct-debit.ts";
import { createPool } from "./pool.ts";
import { withTenant } from "./tenant.ts";

const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);

afterAll(async () => {
  await Promise.all([app.end(), admin.end()]);
});

const ref = (prefix: string) => `${prefix}${randomUUID().replace(/-/g, "").slice(0, 14)}`;

/** A business with an active Direct Debit and one month's charge, its payment made. */
async function chargedBusiness(status = "pending") {
  const tenantId = await createTenant(admin, {
    businessName: "Event Plumbing",
    trade: "plumber",
    notificationEmail: "events@example.com",
  });
  const mandateRef = ref("MD");
  const paymentRef = ref("PM");
  const chargeId = await withTenant(app, tenantId, async (client) => {
    await client.query(
      `INSERT INTO payment_mandates (tenant_id, setup_ref, authorisation_url, expires_at, mandate_ref, status, activated_at)
       VALUES ($1, $2, 'https://pay.fake.invalid', now() + interval '7 days', $3, 'active', now())`,
      [tenantId, ref("BRQ"), mandateRef],
    );
    return (
      await client.query<{ id: string }>(
        `INSERT INTO billing_charges (tenant_id, period_start, period_end, period_index,
           billable_seconds, fee_pence, overage_minutes, overage_pence, vat_rate_percent,
           vat_pence, total_pence, lines, status, payment_ref)
         VALUES ($1, '2026-09-14', '2026-10-14', 3, 0, 9900, 0, 0, 0, 0, 9900, '[]', $2, $3)
         RETURNING id`,
        [tenantId, status, paymentRef],
      )
    ).rows[0]!.id;
  });
  return { tenantId, mandateRef, paymentRef, chargeId };
}

const charge = async (chargeId: string) =>
  (
    await admin.query<{ status: string; failure_reason: string | null }>(
      "SELECT status, failure_reason FROM billing_charges WHERE id = $1",
      [chargeId],
    )
  ).rows[0];

const paymentEvent = (paymentRef: string, action: string, cause: string | null = null) =>
  ({
    id: `EV${randomUUID()}`,
    resourceType: "payments",
    action,
    cause,
    description: null,
    links: { payment: paymentRef },
    createdAt: new Date("2026-10-15T09:00:00Z"),
  }) satisfies PaymentsEvent;

const mandateEvent = (mandateRef: string, action: string, cause: string | null = null) =>
  ({
    id: `EV${randomUUID()}`,
    resourceType: "mandates",
    action,
    cause,
    description: null,
    links: { mandate: mandateRef },
    createdAt: new Date("2026-10-15T09:00:00Z"),
  }) satisfies PaymentsEvent;

/** Every order of a list. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

function recorder() {
  const enqueueBillingEmail = vi.fn((_job: BillingEmailJobData, _client?: unknown) =>
    Promise.resolve(),
  );
  const emails = (kind: BillingEmailJobData["kind"]) =>
    enqueueBillingEmail.mock.calls.filter(([job]) => job.kind === kind).map(([job]) => job);
  return { enqueueBillingEmail, emails };
}

const failedOutcomes = (outcomes: EventOutcome[]) =>
  outcomes.filter((o) => o.outcome === "handled" && o.paymentFailed !== undefined);

describe("a payment's events in any order", () => {
  it.each(permutations(["submitted", "confirmed", "paid_out"]))(
    "%s, %s, %s: ends paid out, and nobody is told it failed",
    async (...actions) => {
      const { paymentRef, chargeId } = await chargedBusiness();
      const { enqueueBillingEmail } = recorder();
      for (const action of actions) {
        await handlePaymentsEvent(app, paymentEvent(paymentRef, action), { enqueueBillingEmail });
      }
      expect(await charge(chargeId)).toEqual({ status: "paid_out", failure_reason: null });
      expect(enqueueBillingEmail).not.toHaveBeenCalled();
    },
  );

  it.each(permutations(["submitted", "confirmed", "failed"]))(
    "%s, %s, %s: ends failed, told once",
    async (...actions) => {
      const { tenantId, paymentRef, chargeId } = await chargedBusiness();
      const { enqueueBillingEmail, emails } = recorder();
      const outcomes: EventOutcome[] = [];
      const events = actions.map((action) =>
        paymentEvent(paymentRef, action, action === "failed" ? "insufficient_funds" : null),
      );
      for (const event of events) {
        outcomes.push(await handlePaymentsEvent(app, event, { enqueueBillingEmail }));
      }
      expect(await charge(chargeId)).toEqual({
        status: "failed",
        failure_reason: "insufficient_funds",
      });
      const failed = events.find((event) => event.action === "failed")!;
      expect(emails("payment_failed")).toEqual([
        { tenantId, kind: "payment_failed", ref: `${chargeId}:${failed.id}`, chargeId },
      ]);
      expect(failedOutcomes(outcomes)).toEqual([
        {
          outcome: "handled",
          tenantId,
          paymentFailed: {
            status: "failed",
            reason: "insufficient_funds",
            periodStart: "2026-09-14",
          },
        },
      ]);
    },
  );

  it("doesn't treat a payment paid out after it failed as paid: only a resubmission starts over", async () => {
    const { paymentRef, chargeId } = await chargedBusiness();
    await handlePaymentsEvent(app, paymentEvent(paymentRef, "failed", "refer_to_payer"));
    for (const action of ["submitted", "confirmed", "paid_out", "pending", "collecting"]) {
      expect(await handlePaymentsEvent(app, paymentEvent(paymentRef, action))).toMatchObject({
        outcome: "ignored",
      });
    }
    expect(await charge(chargeId)).toEqual({ status: "failed", failure_reason: "refer_to_payer" });
  });

  it("tells the business once about a charge-back, and again only after it was collected again", async () => {
    const { paymentRef, chargeId } = await chargedBusiness("paid_out");
    const { enqueueBillingEmail, emails } = recorder();
    const send = (action: string, cause: string | null = null) =>
      handlePaymentsEvent(app, paymentEvent(paymentRef, action, cause), { enqueueBillingEmail });

    await send("charged_back", "refund_requested");
    // Another bad ending on top of one already told: recorded, not told again.
    await send("failed", "late_failure");
    expect(emails("payment_failed")).toHaveLength(1);
    expect(["charged_back", "failed"]).toContain((await charge(chargeId))?.status);
  });

  it("ignores the provider's informational payment events, changing nothing", async () => {
    const { paymentRef, chargeId } = await chargedBusiness("confirmed");
    const { enqueueBillingEmail } = recorder();
    for (const action of [
      "created",
      "customer_approval_granted",
      "late_failure_settled",
      "chargeback_settled",
      "surcharge_fee_debited",
      "something_new_from_the_provider",
    ]) {
      expect(
        await handlePaymentsEvent(app, paymentEvent(paymentRef, action), { enqueueBillingEmail }),
      ).toMatchObject({ outcome: "ignored" });
    }
    expect(await charge(chargeId)).toEqual({ status: "confirmed", failure_reason: null });
    expect(enqueueBillingEmail).not.toHaveBeenCalled();
  });
});

describe("repeats", () => {
  it("handles one event once, however often it's delivered, even at the same moment", async () => {
    const { tenantId, paymentRef, chargeId } = await chargedBusiness();
    const { enqueueBillingEmail, emails } = recorder();
    const failed = paymentEvent(paymentRef, "failed", "insufficient_funds");
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => handlePaymentsEvent(app, failed, { enqueueBillingEmail })),
    );
    expect(outcomes.filter((o) => o.outcome === "handled")).toHaveLength(1);
    expect(outcomes.filter((o) => o.outcome === "duplicate")).toHaveLength(4);
    expect(emails("payment_failed")).toEqual([
      { tenantId, kind: "payment_failed", ref: `${chargeId}:${failed.id}`, chargeId },
    ]);
    const { rows } = await admin.query("SELECT 1 FROM payment_events WHERE event_id = $1", [
      failed.id,
    ]);
    expect(rows).toHaveLength(1);
  });

  it("tells a failure once when two different events say so", async () => {
    const { paymentRef } = await chargedBusiness();
    const { enqueueBillingEmail, emails } = recorder();
    await Promise.all([
      handlePaymentsEvent(app, paymentEvent(paymentRef, "failed", "insufficient_funds"), {
        enqueueBillingEmail,
      }),
      handlePaymentsEvent(app, paymentEvent(paymentRef, "failed", "insufficient_funds"), {
        enqueueBillingEmail,
      }),
    ]);
    expect(emails("payment_failed")).toHaveLength(1);
  });

  it("ends a Direct Debit once, whichever ending events follow", async () => {
    const { tenantId, mandateRef } = await chargedBusiness();
    const { enqueueBillingEmail, emails } = recorder();
    const first = await handlePaymentsEvent(
      app,
      mandateEvent(mandateRef, "cancelled", "bank_account_closed"),
      {
        enqueueBillingEmail,
      },
    );
    expect(first).toEqual({
      outcome: "handled",
      tenantId,
      mandateEnded: { status: "cancelled", reason: "bank_account_closed" },
    });
    for (const action of ["cancelled", "expired", "failed", "blocked", "consumed"]) {
      expect(
        await handlePaymentsEvent(app, mandateEvent(mandateRef, action), { enqueueBillingEmail }),
      ).toEqual({ outcome: "ignored", tenantId });
    }
    expect(emails("direct_debit_ended")).toEqual([
      { tenantId, kind: "direct_debit_ended", ref: mandateRef },
    ]);
    const { rows } = await admin.query(
      "SELECT status, end_reason FROM payment_mandates WHERE mandate_ref = $1",
      [mandateRef],
    );
    expect(rows).toEqual([{ status: "cancelled", end_reason: "bank_account_closed" }]);
  });
});

describe("each way a Direct Debit can end", () => {
  it.each([
    ["cancelled", "cancelled"],
    ["expired", "cancelled"],
    ["consumed", "cancelled"],
    ["blocked", "failed"],
    ["failed", "failed"],
  ])("%s ends it as %s, and the business is told", async (action, status) => {
    const { tenantId, mandateRef } = await chargedBusiness();
    const { enqueueBillingEmail, emails } = recorder();
    expect(
      await handlePaymentsEvent(app, mandateEvent(mandateRef, action, "a_cause"), {
        enqueueBillingEmail,
      }),
    ).toEqual({ outcome: "handled", tenantId, mandateEnded: { status, reason: "a_cause" } });
    expect(emails("direct_debit_ended")).toHaveLength(1);
    const { rows } = await admin.query<{ status: string }>(
      "SELECT status FROM payment_mandates WHERE mandate_ref = $1",
      [mandateRef],
    );
    expect(rows).toEqual([{ status }]);
  });

  it("doesn't end it for events that aren't an ending", async () => {
    const { tenantId, mandateRef } = await chargedBusiness();
    for (const action of [
      "created",
      "submitted",
      "active",
      "transferred",
      "resubmission_requested",
    ]) {
      expect(await handlePaymentsEvent(app, mandateEvent(mandateRef, action))).toEqual({
        outcome: "ignored",
        tenantId,
      });
    }
    const { rows } = await admin.query(
      "SELECT status FROM payment_mandates WHERE mandate_ref = $1",
      [mandateRef],
    );
    expect(rows).toEqual([{ status: "active" }]);
  });

  it("won't reinstate an old Direct Debit over a newer one, or replace one that isn't in use", async () => {
    const { tenantId, mandateRef } = await chargedBusiness();
    await handlePaymentsEvent(app, mandateEvent(mandateRef, "cancelled"));
    // The business set up a new one since.
    const newer = ref("MD");
    await withTenant(app, tenantId, (client) =>
      client.query(
        `INSERT INTO payment_mandates (tenant_id, setup_ref, authorisation_url, expires_at, mandate_ref, status, activated_at)
         VALUES ($1, $2, 'https://pay.fake.invalid', now() + interval '7 days', $3, 'active', now())`,
        [tenantId, ref("BRQ"), newer],
      ),
    );
    expect(await handlePaymentsEvent(app, mandateEvent(mandateRef, "reinstated"))).toEqual({
      outcome: "ignored",
      tenantId,
    });
    expect(
      await handlePaymentsEvent(app, {
        ...mandateEvent(mandateRef, "replaced"),
        links: { mandate: mandateRef, newMandate: ref("MD") },
      }),
    ).toEqual({ outcome: "ignored", tenantId });
    const { rows } = await admin.query<{ mandate_ref: string; status: string }>(
      "SELECT mandate_ref, status FROM payment_mandates WHERE tenant_id = $1 ORDER BY status",
      [tenantId],
    );
    expect(rows).toEqual([
      { mandate_ref: newer, status: "active" },
      { mandate_ref: mandateRef, status: "cancelled" },
    ]);
  });
});

describe("collecting a failed payment again", () => {
  it("keeps a month the retry paid as paid, when the provider's 'resubmission requested' arrives late", async () => {
    // Phil presses Collect again; GoCardless's resubmission_requested event is delivered late
    // (its first delivery failed and was retried) after the retried payment has paid out.
    const { tenantId, paymentRef, chargeId } = await chargedBusiness();
    const payments = new FakePaymentsProvider();
    const userId = (
      await admin.query<{ id: string }>(
        "INSERT INTO users (auth_subject, email, role) VALUES ($1, $2, 'admin') RETURNING id",
        [`sub_${randomUUID()}`, `admin-${randomUUID()}@example.com`],
      )
    ).rows[0]!.id;
    await handlePaymentsEvent(app, paymentEvent(paymentRef, "failed", "insufficient_funds"));
    expect(await collectAgain(app, payments, tenantId, chargeId, userId)).toEqual({
      outcome: "collecting",
      status: "pending",
    });
    expect(payments.retried).toEqual([paymentRef]);
    for (const action of ["submitted", "confirmed", "paid_out"]) {
      await handlePaymentsEvent(app, paymentEvent(paymentRef, action));
    }
    expect(await charge(chargeId)).toEqual({ status: "paid_out", failure_reason: null });

    await handlePaymentsEvent(app, paymentEvent(paymentRef, "resubmission_requested"));
    expect(await charge(chargeId)).toEqual({ status: "paid_out", failure_reason: null });
  });

  it("starts a failed month over on a resubmission, and tells a second failure again", async () => {
    const { tenantId, paymentRef, chargeId } = await chargedBusiness();
    const { enqueueBillingEmail, emails } = recorder();
    const sent: string[] = [];
    const send = (action: string, cause: string | null = null) => {
      const event = paymentEvent(paymentRef, action, cause);
      sent.push(event.id);
      return handlePaymentsEvent(app, event, { enqueueBillingEmail });
    };
    await send("failed", "insufficient_funds");
    const firstFailure = sent.at(-1)!;
    await send("resubmission_requested");
    expect(await charge(chargeId)).toEqual({ status: "pending", failure_reason: null });
    await send("submitted");
    expect((await send("failed", "insufficient_funds")) as unknown).toMatchObject({
      outcome: "handled",
      paymentFailed: { status: "failed" },
    });
    const secondFailure = sent.at(-1)!;
    // Each failure is its own email, keyed by the event that said so (billing_emails is one
    // per key), so the second is sent too, not taken for the first.
    expect(emails("payment_failed")).toEqual([
      { tenantId, kind: "payment_failed", ref: `${chargeId}:${firstFailure}`, chargeId },
      { tenantId, kind: "payment_failed", ref: `${chargeId}:${secondFailure}`, chargeId },
    ]);
  });

  it("follows a cancelled month's new payment, and the old payment's late events change nothing", async () => {
    const { tenantId, paymentRef, chargeId } = await chargedBusiness();
    const payments = new FakePaymentsProvider();
    const { enqueueBillingEmail, emails } = recorder();
    const userId = (
      await admin.query<{ id: string }>(
        "INSERT INTO users (auth_subject, email, role) VALUES ($1, $2, 'admin') RETURNING id",
        [`sub_${randomUUID()}`, `admin-${randomUUID()}@example.com`],
      )
    ).rows[0]!.id;
    await handlePaymentsEvent(app, paymentEvent(paymentRef, "cancelled"), { enqueueBillingEmail });
    expect(await collectAgain(app, payments, tenantId, chargeId, userId)).toEqual({
      outcome: "collecting",
      status: "pending",
    });
    const newRef = payments.payments[0]!.paymentRef;
    // The old payment, cancelled for good, says so again: not this month's payment any more.
    await handlePaymentsEvent(app, paymentEvent(paymentRef, "cancelled"), { enqueueBillingEmail });
    expect((await charge(chargeId))?.status).toBe("pending");
    // The new one fails: told, as a failure of its own.
    const failed = paymentEvent(newRef, "failed", "insufficient_funds");
    await handlePaymentsEvent(app, failed, { enqueueBillingEmail });
    expect(await charge(chargeId)).toEqual({
      status: "failed",
      failure_reason: "insufficient_funds",
    });
    expect(emails("payment_failed").map((job) => job.ref)).toEqual([
      expect.stringMatching(new RegExp(`^${chargeId}:EV`)),
      `${chargeId}:${failed.id}`,
    ]);
  });

  it("ignores a resubmission for a month still on its way", async () => {
    const { paymentRef, chargeId } = await chargedBusiness("submitted");
    expect(
      await handlePaymentsEvent(app, paymentEvent(paymentRef, "resubmission_requested")),
    ).toMatchObject({ outcome: "ignored" });
    expect((await charge(chargeId))?.status).toBe("submitted");
  });
});

/** An event as it happened at a given moment, by the provider's clock (its created_at). */
const at = (event: PaymentsEvent, createdAt: string): PaymentsEvent => ({
  ...event,
  createdAt: new Date(createdAt),
});

describe("events in the order they happened at the provider", () => {
  it("ignores a failure delivered late, after the payment collected again was paid out", async () => {
    // The failure's first delivery fails (the webhook answered 500), and GoCardless sends it
    // again hours later. Meanwhile the payment was retried from GoCardless's dashboard and
    // went all the way to paid out. The old failure must not undo that, or tell anyone.
    const { tenantId, paymentRef, chargeId } = await chargedBusiness();
    const { enqueueBillingEmail } = recorder();
    const send = (event: PaymentsEvent) => handlePaymentsEvent(app, event, { enqueueBillingEmail });
    const failure = at(
      paymentEvent(paymentRef, "failed", "insufficient_funds"),
      "2026-10-01T09:00:00Z",
    );
    await send(at(paymentEvent(paymentRef, "resubmission_requested"), "2026-10-01T12:00:00Z"));
    await send(at(paymentEvent(paymentRef, "submitted"), "2026-10-02T09:00:00Z"));
    await send(at(paymentEvent(paymentRef, "confirmed"), "2026-10-05T09:00:00Z"));
    await send(at(paymentEvent(paymentRef, "paid_out"), "2026-10-06T09:00:00Z"));
    expect(await send(failure)).toEqual({ outcome: "ignored", tenantId });
    expect(await charge(chargeId)).toEqual({ status: "paid_out", failure_reason: null });
    expect(enqueueBillingEmail).not.toHaveBeenCalled();
  });

  it("still takes a failure that happened after the payment was paid out (a late failure)", async () => {
    const { tenantId, paymentRef, chargeId } = await chargedBusiness();
    const { enqueueBillingEmail, emails } = recorder();
    await handlePaymentsEvent(
      app,
      at(paymentEvent(paymentRef, "paid_out"), "2026-10-06T09:00:00Z"),
      { enqueueBillingEmail },
    );
    const lateFailure = at(
      paymentEvent(paymentRef, "failed", "late_failure"),
      "2026-10-08T09:00:00Z",
    );
    expect(await handlePaymentsEvent(app, lateFailure, { enqueueBillingEmail })).toMatchObject({
      outcome: "handled",
      paymentFailed: { status: "failed" },
    });
    expect(await charge(chargeId)).toEqual({ status: "failed", failure_reason: "late_failure" });
    expect(emails("payment_failed")).toEqual([
      { tenantId, kind: "payment_failed", ref: `${chargeId}:${lateFailure.id}`, chargeId },
    ]);
  });

  it("orders by the provider's time, not by arrival: an older 'submitted' after 'confirmed' changes nothing", async () => {
    const { paymentRef, chargeId } = await chargedBusiness();
    await handlePaymentsEvent(
      app,
      at(paymentEvent(paymentRef, "confirmed"), "2026-10-05T09:00:00Z"),
    );
    expect(
      await handlePaymentsEvent(
        app,
        at(paymentEvent(paymentRef, "submitted"), "2026-10-02T09:00:00Z"),
      ),
    ).toMatchObject({ outcome: "ignored" });
    expect((await charge(chargeId))?.status).toBe("confirmed");
    const { rows } = await admin.query<{ last_event_at: Date }>(
      "SELECT last_event_at FROM billing_charges WHERE id = $1",
      [chargeId],
    );
    expect(rows[0]?.last_event_at.toISOString()).toBe("2026-10-05T09:00:00.000Z");
  });
});

describe("a chargeback reversed", () => {
  const reversals = async (tenantId: string) =>
    (
      await admin.query<{ actor_user_id: string | null; details: unknown }>(
        "SELECT actor_user_id, details FROM audit_log WHERE tenant_id = $1 AND action = 'billing.chargeback-cancelled'",
        [tenantId],
      )
    ).rows;

  it("puts a month that was paid out back to paid out, records and audits it, and tells nobody", async () => {
    const { tenantId, paymentRef, chargeId } = await chargedBusiness();
    const { enqueueBillingEmail, emails } = recorder();
    const send = (action: string, createdAt: string, cause: string | null = null) =>
      handlePaymentsEvent(app, at(paymentEvent(paymentRef, action, cause), createdAt), {
        enqueueBillingEmail,
      });
    await send("paid_out", "2026-10-06T09:00:00Z");
    await send("charged_back", "2026-10-20T09:00:00Z", "refund_requested");
    expect(emails("payment_failed")).toHaveLength(1);

    const reversed = await send("chargeback_cancelled", "2026-10-27T09:00:00Z");
    // Handled, but not a failure: the route neither alerts nor emails for it.
    expect(reversed).toEqual({ outcome: "handled", tenantId });
    expect(await charge(chargeId)).toEqual({ status: "paid_out", failure_reason: null });
    expect(emails("payment_failed")).toHaveLength(1);
    expect(enqueueBillingEmail).toHaveBeenCalledTimes(1);
    expect(await reversals(tenantId)).toEqual([
      { actor_user_id: null, details: { chargeId, paymentRef, status: "paid_out" } },
    ]);
    const { rows } = await admin.query("SELECT action FROM payment_events WHERE tenant_id = $1", [
      tenantId,
    ]);
    expect(rows).toContainEqual({ action: "chargeback_cancelled" });
  });

  it("puts a month charged back before it was paid out back to confirmed", async () => {
    const { tenantId, paymentRef, chargeId } = await chargedBusiness("confirmed");
    await handlePaymentsEvent(
      app,
      at(paymentEvent(paymentRef, "charged_back", "refund_requested"), "2026-10-06T09:00:00Z"),
    );
    await handlePaymentsEvent(
      app,
      at(paymentEvent(paymentRef, "chargeback_cancelled"), "2026-10-09T09:00:00Z"),
    );
    expect(await charge(chargeId)).toEqual({ status: "confirmed", failure_reason: null });
    expect(await reversals(tenantId)).toHaveLength(1);
  });

  it("changes nothing for a month that wasn't charged back, or for a reversal older than the chargeback", async () => {
    const paid = await chargedBusiness("paid_out");
    expect(
      await handlePaymentsEvent(app, paymentEvent(paid.paymentRef, "chargeback_cancelled")),
    ).toEqual({ outcome: "ignored", tenantId: paid.tenantId });
    expect((await charge(paid.chargeId))?.status).toBe("paid_out");

    const chargedBack = await chargedBusiness("paid_out");
    await handlePaymentsEvent(
      app,
      at(paymentEvent(chargedBack.paymentRef, "charged_back"), "2026-10-20T09:00:00Z"),
    );
    await handlePaymentsEvent(
      app,
      at(paymentEvent(chargedBack.paymentRef, "chargeback_cancelled"), "2026-10-19T09:00:00Z"),
    );
    expect((await charge(chargedBack.chargeId))?.status).toBe("charged_back");
    expect(await reversals(chargedBack.tenantId)).toEqual([]);
  });
});

describe("the customer turning a payment down", () => {
  it("is a failed payment, as the morning run records it: told once, with the reason", async () => {
    const { tenantId, paymentRef, chargeId } = await chargedBusiness();
    const { enqueueBillingEmail, emails } = recorder();
    const denied = paymentEvent(paymentRef, "customer_approval_denied", "customer_denied");
    expect(await handlePaymentsEvent(app, denied, { enqueueBillingEmail })).toEqual({
      outcome: "handled",
      tenantId,
      paymentFailed: { status: "failed", reason: "customer_denied", periodStart: "2026-09-14" },
    });
    expect(await charge(chargeId)).toEqual({ status: "failed", failure_reason: "customer_denied" });
    expect(emails("payment_failed")).toEqual([
      { tenantId, kind: "payment_failed", ref: `${chargeId}:${denied.id}`, chargeId },
    ]);
  });
});

describe("events about things it doesn't know", () => {
  it("records nothing for a payment and mandate nobody here has", async () => {
    const event = {
      ...paymentEvent(ref("PM"), "failed"),
      links: { payment: ref("PM"), mandate: ref("MD") },
    };
    expect(await handlePaymentsEvent(app, event)).toEqual({ outcome: "unknown" });
    const { rows } = await admin.query("SELECT 1 FROM payment_events WHERE event_id = $1", [
      event.id,
    ]);
    expect(rows).toEqual([]);
  });

  it("finds the business by its Direct Debit for a payment made elsewhere, and changes no charge", async () => {
    // A payment taken by hand from the provider's dashboard: the mandate is ours, the payment isn't.
    const { tenantId, mandateRef, chargeId } = await chargedBusiness();
    const { enqueueBillingEmail } = recorder();
    expect(
      await handlePaymentsEvent(
        app,
        {
          ...paymentEvent(ref("PM"), "failed"),
          links: { payment: ref("PM"), mandate: mandateRef },
        },
        { enqueueBillingEmail },
      ),
    ).toEqual({ outcome: "ignored", tenantId });
    expect(await charge(chargeId)).toEqual({ status: "pending", failure_reason: null });
    expect(enqueueBillingEmail).not.toHaveBeenCalled();
  });

  it("acts on the business whose payment it is, never on another's", async () => {
    const mine = await chargedBusiness();
    const theirs = await chargedBusiness();
    // A payment event that also names someone else's mandate: the payment decides whose it is.
    const event = {
      ...paymentEvent(mine.paymentRef, "failed", "insufficient_funds"),
      links: { payment: mine.paymentRef, mandate: theirs.mandateRef },
    };
    expect(await handlePaymentsEvent(app, event)).toMatchObject({
      outcome: "handled",
      tenantId: mine.tenantId,
    });
    expect((await charge(mine.chargeId))?.status).toBe("failed");
    expect((await charge(theirs.chargeId))?.status).toBe("pending");
    const { rows } = await admin.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM payment_events WHERE event_id = $1",
      [event.id],
    );
    expect(rows).toEqual([{ tenant_id: mine.tenantId }]);
  });

  it("never lets one business's mandate event end another's Direct Debit", async () => {
    const mine = await chargedBusiness();
    const theirs = await chargedBusiness();
    await handlePaymentsEvent(app, mandateEvent(mine.mandateRef, "cancelled"));
    const { rows } = await admin.query<{ status: string }>(
      "SELECT status FROM payment_mandates WHERE tenant_id = $1",
      [theirs.tenantId],
    );
    expect(rows).toEqual([{ status: "active" }]);
  });
});
