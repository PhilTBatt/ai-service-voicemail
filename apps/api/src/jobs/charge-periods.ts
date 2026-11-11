// Charging (BUILD_PLAN Step 12; decision 019). Every morning: each paying business's billing
// months that have ended and aren't charged yet get their charge worked out (the fee, overage
// rounded up once for the month, VAT if registered), recorded, and collected by Direct Debit,
// and the receipt queued. Safe to run again, or to stop part-way:
// - the charge row is made first, one per business per month, before the provider is asked;
// - the payment is asked for with an idempotency key from the business and the month, so a
//   repeat after a crash gets the same payment back, never a second;
// - a month with nothing to collect from (no Direct Debit) is tried again each morning.
// Nothing is ever switched off for not paying: that stays a person's decision. A month the
// business spent suspended from start to end is recorded as nothing due (tenant_suspensions).
import { AI_ANSWERING_PLAN, type Plan } from "@callmate/shared";
import type pg from "pg";
import { raiseAlert, type AlertFn } from "../alerts.ts";
import { formatDate, lastDayOf } from "../core/billing-emails.ts";
import {
  chargeFor,
  endedPeriods,
  ukDateOf,
  type BillingPeriod,
  type VatRegistration,
} from "../core/billing.ts";
import { listBillableTenants, type AdminPool, type BillableTenant } from "../db/cross-tenant.ts";
import { activeMandateRef, endMandate } from "../db/direct-debit.ts";
import { withTenant } from "../db/tenant.ts";
import { logger } from "../logger.ts";
import {
  MandateUnusableError,
  MIN_COLLECTABLE_PENCE,
  type PaymentsProvider,
} from "../providers/payments.ts";
import type { EnqueueBillingEmail } from "./billing-email.ts";

export interface ChargePeriodsDeps {
  pool: pg.Pool;
  admin: AdminPool;
  payments: PaymentsProvider;
  enqueueBillingEmail: EnqueueBillingEmail;
  vat: VatRegistration | null;
  plan?: Plan;
  alert?: AlertFn;
  now?: () => Date;
}

export type PeriodOutcome =
  "nothing-due" | "below-minimum" | "no-mandate" | "collected" | "refused" | "already-done";

export interface ChargeRunCounts {
  periods: number;
  collected: number;
  nothingDue: number;
  belowMinimum: number;
  noMandate: number;
  refused: number;
  failedBusinesses: number;
}

/** The whole morning's run: every paying business, every ended month not yet charged. */
export async function runChargePeriods(deps: ChargePeriodsDeps): Promise<ChargeRunCounts> {
  const today = ukDateOf((deps.now ?? (() => new Date()))());
  const counts: ChargeRunCounts = {
    periods: 0,
    collected: 0,
    nothingDue: 0,
    belowMinimum: 0,
    noMandate: 0,
    refused: 0,
    failedBusinesses: 0,
  };
  let lastError: unknown = null;
  for (const tenant of await listBillableTenants(deps.admin)) {
    try {
      for (const period of endedPeriods(tenant.billingStartDate, today, tenant.leftOn)) {
        const outcome = await chargePeriod(deps, tenant, period);
        if (outcome === "already-done") continue;
        counts.periods += 1;
        if (outcome === "collected") counts.collected += 1;
        if (outcome === "nothing-due") counts.nothingDue += 1;
        if (outcome === "no-mandate") counts.noMandate += 1;
        if (outcome === "refused") counts.refused += 1;
        if (outcome === "below-minimum") counts.belowMinimum += 1;
      }
    } catch (error) {
      // One business's trouble (the provider down, say) mustn't stop the others being charged.
      // The run fails at the end, so the queue tries it again; what's done is skipped then.
      counts.failedBusinesses += 1;
      lastError = error;
      logger.error("Charging a business failed; the run will be retried", {
        tenantId: tenant.tenantId,
        error,
      });
    }
  }
  logger.info("Charging run finished", { ...counts });
  if (lastError !== null) {
    throw new Error(`Charging failed for ${counts.failedBusinesses} business(es); retrying`, {
      cause: lastError,
    });
  }
  return counts;
}

interface ChargeRow {
  id: string;
  status: string;
  total_pence: number;
}

/** One business's one month. */
export async function chargePeriod(
  {
    pool,
    payments,
    enqueueBillingEmail,
    vat,
    plan = AI_ANSWERING_PLAN,
    alert = raiseAlert,
  }: ChargePeriodsDeps,
  tenant: BillableTenant,
  period: BillingPeriod,
): Promise<PeriodOutcome> {
  const { tenantId } = tenant;
  // Find the month's charge, or work it out and record it.
  const row = await withTenant(pool, tenantId, async (client) => {
    const existing = (
      await client.query<ChargeRow>(
        "SELECT id, status, total_pence FROM billing_charges WHERE tenant_id = $1 AND period_start = $2",
        [tenantId, period.periodStart],
      )
    ).rows[0];
    if (existing) return { ...existing, isNew: false };
    const usage = (
      await client.query<{ billable_seconds: number }>(
        "SELECT billable_seconds::int FROM usage_periods WHERE tenant_id = $1 AND period_start = $2",
        [tenantId, period.periodStart],
      )
    ).rows[0];
    // Suspended from the month's first moment (UK midnight) to its end, or still suspended:
    // no service that month, so no charge. One that began or ended part-way is charged.
    const suspendedThroughout = (
      await client.query<{ suspended: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM tenant_suspensions
           WHERE tenant_id = $1
             AND started_at <= ($2::date)::timestamp AT TIME ZONE 'Europe/London'
             AND (ended_at IS NULL OR ended_at >= ($3::date)::timestamp AT TIME ZONE 'Europe/London')
         ) AS suspended`,
        [tenantId, period.periodStart, period.periodEnd],
      )
    ).rows[0]!.suspended;
    const charge = chargeFor({
      plan,
      period,
      isPilot: tenant.isPilot,
      billableSeconds: usage?.billable_seconds ?? 0,
      vat,
      suspendedThroughout,
    });
    // Under the provider's minimum (a pilot's free month with a few minutes over): recorded,
    // and not collected. Nothing at all: recorded as nothing due.
    const status =
      charge.totalPence === 0
        ? "nothing_due"
        : charge.totalPence < MIN_COLLECTABLE_PENCE
          ? "below_minimum"
          : "collecting";
    const inserted = (
      await client.query<ChargeRow>(
        `INSERT INTO billing_charges (tenant_id, period_start, period_end, period_index,
           billable_seconds, fee_pence, overage_minutes, overage_pence, vat_rate_percent,
           vat_pence, total_pence, vat_number, lines, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING id, status, total_pence`,
        [
          tenantId,
          period.periodStart,
          period.periodEnd,
          period.index,
          usage?.billable_seconds ?? 0,
          charge.feePence,
          charge.overageMinutes,
          charge.overagePence,
          charge.vatRatePercent,
          charge.vatPence,
          charge.totalPence,
          charge.vatRatePercent > 0 ? vat!.number : null,
          JSON.stringify(charge.lines),
          status,
        ],
      )
    ).rows[0]!;
    return { ...inserted, isNew: true };
  });

  if (row.status === "nothing_due") return row.isNew ? "nothing-due" : "already-done";
  if (row.status === "below_minimum") return row.isNew ? "below-minimum" : "already-done";
  if (row.status !== "collecting" && row.status !== "no_mandate") return "already-done";

  const mandateRef = await withTenant(pool, tenantId, (client) =>
    activeMandateRef(client, tenantId),
  );
  if (!mandateRef) {
    if (row.status === "collecting") {
      await withTenant(pool, tenantId, (client) =>
        client.query("UPDATE billing_charges SET status = 'no_mandate' WHERE id = $1", [row.id]),
      );
      // Once per month owed: it's tried again every morning, quietly.
      alert("billing-no-mandate", {
        tenantId,
        periodStart: period.periodStart,
        totalPence: row.total_pence,
      });
      return "no-mandate";
    }
    return "already-done";
  }

  const description = `AnswerMate, ${formatDate(period.periodStart)} to ${formatDate(lastDayOf(period.periodEnd))}`;
  let receipt;
  try {
    receipt = await payments.createPayment({
      mandateRef,
      amountPence: row.total_pence,
      description,
      metadata: { tenantId, periodStart: period.periodStart },
      idempotencyKey: `charge:${tenantId}:${period.periodStart}`,
    });
  } catch (error) {
    // Anything but an unusable Direct Debit is ours to sort (a wrong token, a refused
    // request, the provider down): the run fails and is retried, then dead-lettered with an
    // alert. The month stays mid-collection, nothing is said to the business, and the next
    // morning tries again. A payment that never existed is never reported as failed.
    if (!(error instanceof MandateUnusableError)) throw error;
    // The provider won't collect from this Direct Debit any more, though no webhook has said
    // so yet: it ends here too, and the month waits for a new one, like a month owed with none.
    const ended = await withTenant(pool, tenantId, async (client) => {
      const wasActive = await endMandate(
        client,
        tenantId,
        mandateRef,
        "cancelled",
        "mandate_unusable",
      );
      if (wasActive) {
        await enqueueBillingEmail(
          { tenantId, kind: "direct_debit_ended", ref: mandateRef },
          client,
        );
      }
      await client.query(
        "UPDATE billing_charges SET status = 'no_mandate' WHERE id = $1 AND status IN ('collecting', 'no_mandate')",
        [row.id],
      );
      return wasActive;
    });
    if (ended) {
      alert("payment-mandate-ended", { tenantId, status: "cancelled", reason: "mandate_unusable" });
    }
    if (row.status === "collecting") {
      alert("billing-no-mandate", {
        tenantId,
        periodStart: period.periodStart,
        totalPence: row.total_pence,
      });
    }
    return "no-mandate";
  }

  // The payment as the provider has it. Usually waiting to be submitted; on a retry after a
  // crash it may have moved on, or ended, and that's what's recorded. Only a month still
  // mid-collection is updated, so a webhook that got there first isn't undone.
  const status = PROVIDER_PAYMENT_STATUS[receipt.status] ?? "pending";
  const bad = status === "failed" || status === "cancelled" || status === "charged_back";
  const recorded = await withTenant(pool, tenantId, async (client) => {
    const { rowCount } = await client.query(
      `UPDATE billing_charges SET status = $4, payment_ref = $2, charge_date = $3
       WHERE id = $1 AND status IN ('collecting', 'no_mandate')`,
      [row.id, receipt.paymentRef, receipt.chargeDate, status],
    );
    if (rowCount !== 1) return false;
    await enqueueBillingEmail(
      { tenantId, kind: bad ? "payment_failed" : "receipt", ref: row.id },
      client,
    );
    return true;
  });
  if (!recorded) return "already-done";
  if (bad) {
    alert("billing-payment-failed", {
      tenantId,
      periodStart: period.periodStart,
      status,
      reason: null,
    });
    return "refused";
  }
  return "collected";
}

/** GoCardless's payment statuses, as a charge's. */
const PROVIDER_PAYMENT_STATUS: Record<string, string> = {
  pending_customer_approval: "pending",
  pending_submission: "pending",
  submitted: "submitted",
  confirmed: "confirmed",
  paid_out: "paid_out",
  cancelled: "cancelled",
  customer_approval_denied: "failed",
  failed: "failed",
  charged_back: "charged_back",
};
