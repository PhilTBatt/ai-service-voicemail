// Direct Debit set-up and its life afterwards (BUILD_PLAN Step 12; decision 019). A business
// is sent to the payments provider's own page to give its bank details; when that's done the
// provider has a mandate to collect against, and the business's onboarding can count payment
// as ready. Everything here runs inside the business's own transaction (withTenant), so
// row-level security applies; the provider is only ever called outside one.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { EnqueueBillingEmail } from "../jobs/billing-email.ts";
import type { EnqueueOnboarding } from "../jobs/onboarding.ts";
import type { PaymentsEvent, PaymentsProvider } from "../providers/payments.ts";
import { findTenantIdByPaymentRef } from "./cross-tenant.ts";
import { withTenant } from "./tenant.ts";

/** A set-up link is reused while it has at least this long left: the provider's last seven days. */
const REUSE_SETUP_FOR_AT_LEAST_MS = 60 * 60_000;

export type DirectDebitStatus = "none" | "pending" | "active" | "ended";

export interface DirectDebitState {
  status: DirectDebitStatus;
  /** When it became active, or when it ended. */
  since: Date | null;
  /** The provider's reason for an ended one ("bank_account_closed"...). */
  endReason: string | null;
}

interface MandateRow {
  setup_ref: string;
  authorisation_url: string;
  expires_at: Date;
  mandate_ref: string | null;
  status: "pending" | "active" | "abandoned" | "cancelled" | "failed";
  end_reason: string | null;
  activated_at: Date | null;
  ended_at: Date | null;
}

const MANDATE_COLUMNS =
  "setup_ref, authorisation_url, expires_at, mandate_ref, status, end_reason, activated_at, ended_at";

/** Where a business's Direct Debit stands: an active mandate first, else the latest attempt. */
export async function directDebitState(
  client: pg.ClientBase,
  tenantId: string,
): Promise<DirectDebitState> {
  const { rows } = await client.query<MandateRow>(
    `SELECT ${MANDATE_COLUMNS} FROM payment_mandates WHERE tenant_id = $1
     ORDER BY (status = 'active') DESC, created_at DESC LIMIT 1`,
    [tenantId],
  );
  const row = rows[0];
  if (!row) return { status: "none", since: null, endReason: null };
  switch (row.status) {
    case "active":
      return { status: "active", since: row.activated_at, endReason: null };
    case "pending":
      return { status: "pending", since: null, endReason: null };
    case "abandoned":
      return { status: "none", since: null, endReason: null };
    case "cancelled":
    case "failed":
      return { status: "ended", since: row.ended_at, endReason: row.end_reason };
  }
}

/** The mandate to collect against, if the business has an active one. */
export async function activeMandateRef(
  client: pg.ClientBase,
  tenantId: string,
): Promise<string | null> {
  const { rows } = await client.query<{ mandate_ref: string }>(
    "SELECT mandate_ref FROM payment_mandates WHERE tenant_id = $1 AND status = 'active'",
    [tenantId],
  );
  return rows[0]?.mandate_ref ?? null;
}

export type StartOutcome =
  | { outcome: "started"; authorisationUrl: string }
  | { outcome: "already-active" }
  | { outcome: "not-allowed"; status: string }
  | { outcome: "not-found" };

/**
 * Sends a business to set up Direct Debit: the provider's page, with the business's name and
 * email filled in. A link made in the last few days is handed back rather than a new one, so
 * two clicks don't make two set-ups. A cancelled business can't start one.
 */
export async function startDirectDebit(
  pool: pg.Pool,
  payments: PaymentsProvider,
  tenantId: string,
  {
    redirectUrl,
    exitUrl,
    actorUserId,
    now,
  }: { redirectUrl: string; exitUrl: string; actorUserId: string; now: Date },
): Promise<StartOutcome> {
  const found = await withTenant(pool, tenantId, async (client) => {
    const tenant = (
      await client.query<{
        business_name: string;
        notification_email: string | null;
        status: string;
      }>("SELECT business_name, notification_email, status FROM tenants WHERE id = $1", [tenantId])
    ).rows[0];
    if (!tenant) return null;
    const reusable = (
      await client.query<{ authorisation_url: string }>(
        `SELECT authorisation_url FROM payment_mandates
         WHERE tenant_id = $1 AND status = 'pending' AND expires_at > $2
         ORDER BY created_at DESC LIMIT 1`,
        [tenantId, new Date(now.getTime() + REUSE_SETUP_FOR_AT_LEAST_MS)],
      )
    ).rows[0];
    return { tenant, active: await activeMandateRef(client, tenantId), reusable };
  });
  if (!found) return { outcome: "not-found" };
  const { tenant, active, reusable } = found;
  if (tenant.status === "cancelling" || tenant.status === "cancelled") {
    return { outcome: "not-allowed", status: tenant.status };
  }
  if (active) return { outcome: "already-active" };
  if (reusable) return { outcome: "started", authorisationUrl: reusable.authorisation_url };

  const setup = await payments.startMandateSetup({
    businessName: tenant.business_name,
    email: tenant.notification_email ?? undefined,
    redirectUrl,
    exitUrl,
    metadata: { tenantId },
    idempotencyKey: `mandate-setup:${tenantId}:${randomUUID()}`,
  });
  await withTenant(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO payment_mandates (tenant_id, setup_ref, authorisation_url, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, setup.setupRef, setup.authorisationUrl, setup.expiresAt],
    );
    await client.query(
      "INSERT INTO audit_log (tenant_id, actor_user_id, action, details) VALUES ($1, $2, 'billing.direct-debit-started', $3)",
      [tenantId, actorUserId, { setupRef: setup.setupRef }],
    );
  });
  return { outcome: "started", authorisationUrl: setup.authorisationUrl };
}

/**
 * The set-up is complete: its mandate is now the one to collect against. Runs in the caller's
 * transaction. A set-up that's no longer pending (the webhook and the person's return can both
 * get here) changes nothing. Queues a go-live check with it, since payment may be the last
 * thing the business was waiting on.
 */
export async function activateMandate(
  client: pg.ClientBase,
  tenantId: string,
  setupRef: string,
  mandateRef: string,
  enqueueOnboarding?: EnqueueOnboarding,
): Promise<boolean> {
  const pending = await client.query(
    "SELECT 1 FROM payment_mandates WHERE tenant_id = $1 AND setup_ref = $2 AND status = 'pending' FOR UPDATE",
    [tenantId, setupRef],
  );
  if (pending.rowCount !== 1) return false;
  // Two set-ups both completed (a second started while the first link was nearly out of time,
  // say): the newest is the one to collect from, and the older one stops being used here.
  // It's still a mandate at the provider, unused; nothing is taken from it.
  await client.query(
    `UPDATE payment_mandates SET status = 'cancelled', end_reason = 'superseded', ended_at = now()
     WHERE tenant_id = $1 AND status = 'active' AND mandate_ref <> $2`,
    [tenantId, mandateRef],
  );
  const { rowCount } = await client.query(
    `UPDATE payment_mandates SET status = 'active', mandate_ref = $3, activated_at = now()
     WHERE tenant_id = $1 AND setup_ref = $2 AND status = 'pending'`,
    [tenantId, setupRef, mandateRef],
  );
  if (rowCount !== 1) return false;
  await client.query(
    "INSERT INTO audit_log (tenant_id, actor_user_id, action, details) VALUES ($1, NULL, 'billing.direct-debit-active', $2)",
    [tenantId, { mandateRef }],
  );
  await enqueueOnboarding?.({ tenantId, action: "go-live" }, client);
  return true;
}

/** A set-up the person gave up on, or that the provider cancelled: no longer pending. */
async function abandonSetup(
  client: pg.ClientBase,
  tenantId: string,
  setupRef: string,
): Promise<void> {
  await client.query(
    "UPDATE payment_mandates SET status = 'abandoned' WHERE tenant_id = $1 AND setup_ref = $2 AND status = 'pending'",
    [tenantId, setupRef],
  );
}

/** An active mandate the bank or the business cancelled, or that failed. True if it was active. */
export async function endMandate(
  client: pg.ClientBase,
  tenantId: string,
  mandateRef: string,
  status: "cancelled" | "failed",
  reason: string | null,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE payment_mandates SET status = $3, end_reason = $4, ended_at = now()
     WHERE tenant_id = $1 AND mandate_ref = $2 AND status = 'active'`,
    [tenantId, mandateRef, status, reason],
  );
  if (rowCount !== 1) return false;
  await client.query(
    "INSERT INTO audit_log (tenant_id, actor_user_id, action, details) VALUES ($1, NULL, 'billing.direct-debit-ended', $2)",
    [tenantId, { mandateRef, status, reason }],
  );
  return true;
}

/**
 * The person has come back from the provider's page (or wants to know where it stands): asks
 * the provider about the latest pending set-up and records what it says. The webhook would
 * record the same thing, usually a moment later; whichever is first wins, and the other
 * changes nothing.
 */
export async function checkDirectDebit(
  pool: pg.Pool,
  payments: PaymentsProvider,
  tenantId: string,
  enqueueOnboarding?: EnqueueOnboarding,
): Promise<DirectDebitState> {
  const pending = await withTenant(
    pool,
    tenantId,
    async (client) =>
      (
        await client.query<{ setup_ref: string }>(
          `SELECT setup_ref FROM payment_mandates WHERE tenant_id = $1 AND status = 'pending'
           ORDER BY created_at DESC LIMIT 1`,
          [tenantId],
        )
      ).rows[0],
  );
  if (pending) {
    const state = await payments.mandateSetupState(pending.setup_ref);
    await withTenant(pool, tenantId, async (client) => {
      if (state.status === "fulfilled" && state.mandateRef) {
        await activateMandate(
          client,
          tenantId,
          pending.setup_ref,
          state.mandateRef,
          enqueueOnboarding,
        );
      } else if (state.status === "cancelled") {
        await abandonSetup(client, tenantId, pending.setup_ref);
      }
    });
  }
  return withTenant(pool, tenantId, (client) => directDebitState(client, tenantId));
}

/** Mandate actions after which nothing more can be collected (GoCardless's mandate events). */
const MANDATE_ENDED: Record<string, "cancelled" | "failed"> = {
  cancelled: "cancelled",
  expired: "cancelled",
  consumed: "cancelled",
  blocked: "failed",
  failed: "failed",
};

/**
 * A payment's progress at the provider, in order. Events can arrive out of order (GoCardless
 * says so), so a charge only ever moves forward: "confirmed" after "paid out" is ignored. The
 * bad endings outrank everything, because a payment can fail late, after it was confirmed.
 */
const PAYMENT_PROGRESS: Record<string, number> = {
  collecting: 0,
  pending: 0,
  submitted: 1,
  confirmed: 2,
  paid_out: 3,
  failed: 4,
  cancelled: 4,
  charged_back: 4,
};
const PAYMENT_BAD = new Set(["failed", "cancelled", "charged_back"]);

/** Moves a charge to what the provider says of its payment, if that's forward. */
async function recordPaymentProgress(
  client: pg.ClientBase,
  paymentRef: string,
  action: string,
  cause: string | null,
): Promise<{ chargeId: string; periodStart: string; status: string; becameBad: boolean } | null> {
  const resubmitted = action === "resubmission_requested";
  if (
    !resubmitted &&
    (PAYMENT_PROGRESS[action] === undefined || action === "pending" || action === "collecting")
  ) {
    return null;
  }
  const charge = (
    await client.query<{ id: string; status: string; period_start: string }>(
      "SELECT id, status, period_start::text FROM billing_charges WHERE payment_ref = $1 FOR UPDATE",
      [paymentRef],
    )
  ).rows[0];
  if (!charge) return null;
  // A failed payment collected again (from the provider's dashboard, decision 019) keeps its
  // ID and starts over: back to pending, so its progress from here is recorded, and a later
  // failure is said again.
  if (resubmitted) {
    await client.query(
      "UPDATE billing_charges SET status = 'pending', failure_reason = NULL WHERE id = $1",
      [charge.id],
    );
    return {
      chargeId: charge.id,
      periodStart: charge.period_start,
      status: "pending",
      becameBad: false,
    };
  }
  const was = PAYMENT_PROGRESS[charge.status] ?? 0;
  const now = PAYMENT_PROGRESS[action] ?? 0;
  if (now < was || charge.status === action) return null;
  await client.query(
    `UPDATE billing_charges SET status = $2,
            failure_reason = CASE WHEN $3::boolean THEN $4 ELSE failure_reason END
     WHERE id = $1`,
    [charge.id, action, PAYMENT_BAD.has(action), cause],
  );
  return {
    chargeId: charge.id,
    periodStart: charge.period_start,
    status: action,
    becameBad: PAYMENT_BAD.has(action) && !PAYMENT_BAD.has(charge.status),
  };
}

export type EventOutcome =
  | { outcome: "unknown" }
  | { outcome: "duplicate"; tenantId: string }
  | {
      outcome: "handled";
      tenantId: string;
      mandateEnded?: { status: string; reason: string | null };
      paymentFailed?: { status: string; reason: string | null; periodStart: string };
    }
  | { outcome: "ignored"; tenantId: string };

/**
 * One event from the provider's webhook. Found by the reference it names (the set-up, the
 * mandate or the payment), recorded once by its event ID, then acted on in the same
 * transaction, so a delivery that's repeated, or retried after a failure part-way, is handled
 * once. Emails to the business are queued in that transaction too.
 */
export async function handlePaymentsEvent(
  pool: pg.Pool,
  event: PaymentsEvent,
  {
    enqueueOnboarding,
    enqueueBillingEmail,
  }: {
    enqueueOnboarding?: EnqueueOnboarding | undefined;
    enqueueBillingEmail?: EnqueueBillingEmail | undefined;
  } = {},
): Promise<EventOutcome> {
  const refs = [
    event.resourceType === "billing_requests" ? event.links.billingRequest : undefined,
    event.resourceType === "mandates" ? event.links.mandate : undefined,
    event.resourceType === "payments" ? event.links.payment : undefined,
    event.links.billingRequest,
    event.links.mandate,
    event.links.payment,
  ].filter((ref): ref is string => typeof ref === "string" && ref !== "");
  let tenantId: string | null = null;
  for (const ref of refs) {
    tenantId = await findTenantIdByPaymentRef(pool, ref);
    if (tenantId) break;
  }
  if (!tenantId) return { outcome: "unknown" };
  const found = tenantId;

  return withTenant(pool, found, async (client): Promise<EventOutcome> => {
    const recorded = await client.query(
      `INSERT INTO payment_events (event_id, tenant_id, resource_type, action, cause, resource_ref)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (event_id) DO NOTHING`,
      [event.id, found, event.resourceType, event.action, event.cause, refs[0] ?? null],
    );
    if (recorded.rowCount !== 1) return { outcome: "duplicate", tenantId: found };

    if (event.resourceType === "billing_requests" && event.links.billingRequest) {
      if (event.action === "fulfilled" && event.links.mandate) {
        await activateMandate(
          client,
          found,
          event.links.billingRequest,
          event.links.mandate,
          enqueueOnboarding,
        );
        return { outcome: "handled", tenantId: found };
      }
      if (event.action === "cancelled" || event.action === "failed") {
        await abandonSetup(client, found, event.links.billingRequest);
        return { outcome: "handled", tenantId: found };
      }
    }
    if (event.resourceType === "mandates" && event.links.mandate) {
      // Replaced (a scheme change, say): the new mandate takes over the old one's place.
      if (event.action === "replaced" && event.links.newMandate) {
        const { rowCount } = await client.query(
          "UPDATE payment_mandates SET mandate_ref = $3 WHERE tenant_id = $1 AND mandate_ref = $2 AND status = 'active'",
          [found, event.links.mandate, event.links.newMandate],
        );
        return rowCount === 1
          ? { outcome: "handled", tenantId: found }
          : { outcome: "ignored", tenantId: found };
      }
      // Reinstated after it ended: usable again, unless the business has set up another since.
      if (event.action === "reinstated") {
        const { rowCount } = await client.query(
          `UPDATE payment_mandates SET status = 'active', end_reason = NULL, ended_at = NULL
           WHERE tenant_id = $1 AND mandate_ref = $2 AND status IN ('cancelled', 'failed')
             AND NOT EXISTS (SELECT 1 FROM payment_mandates other
                             WHERE other.tenant_id = $1 AND other.status = 'active')`,
          [found, event.links.mandate],
        );
        return rowCount === 1
          ? { outcome: "handled", tenantId: found }
          : { outcome: "ignored", tenantId: found };
      }
      const ended = MANDATE_ENDED[event.action];
      if (ended && (await endMandate(client, found, event.links.mandate, ended, event.cause))) {
        await enqueueBillingEmail?.(
          { tenantId: found, kind: "direct_debit_ended", ref: event.links.mandate },
          client,
        );
        return {
          outcome: "handled",
          tenantId: found,
          mandateEnded: { status: ended, reason: event.cause },
        };
      }
    }
    if (event.resourceType === "payments" && event.links.payment) {
      const progress = await recordPaymentProgress(
        client,
        event.links.payment,
        event.action,
        event.cause,
      );
      if (progress) {
        if (progress.becameBad) {
          await enqueueBillingEmail?.(
            { tenantId: found, kind: "payment_failed", ref: progress.chargeId },
            client,
          );
          return {
            outcome: "handled",
            tenantId: found,
            paymentFailed: {
              status: progress.status,
              reason: event.cause,
              periodStart: progress.periodStart,
            },
          };
        }
        return { outcome: "handled", tenantId: found };
      }
    }
    return { outcome: "ignored", tenantId: found };
  });
}
