// What a business sees of its billing (BUILD_PLAN Step 12; decision 019): the plan, the
// current billing month so far (its bill as the month-end charge would work it out today, where
// it's heading, and its minutes day by day), and its Direct Debit. Read inside the business's
// own transaction.
import { AI_ANSWERING_PLAN, type BillingView } from "@callmate/shared";
import type pg from "pg";
import {
  chargeFor,
  currentBillingPeriod,
  daysOfMonth,
  monthProgress,
  projectedSeconds,
  ukDateOf,
} from "../core/billing.ts";
import { invoiceNumberText } from "../core/invoice.ts";
import { startOfUkDate } from "../core/usage.ts";
import { directDebitState } from "./direct-debit.ts";
import { withTenant } from "./tenant.ts";

export async function loadBillingView(
  pool: pg.Pool,
  tenantId: string,
  { now, available }: { now: Date; available: boolean },
): Promise<BillingView | null> {
  return withTenant(pool, tenantId, async (client) => {
    const tenant = (
      await client.query<{
        is_pilot: boolean;
        billing_start_date: string | null;
        status: string;
        cancellation_requested_at: Date | null;
        billing_address: string | null;
      }>(
        `SELECT is_pilot, billing_start_date::text, status, cancellation_requested_at, billing_address
         FROM tenants WHERE id = $1`,
        [tenantId],
      )
    ).rows[0];
    if (!tenant) return null;
    const plan = AI_ANSWERING_PLAN;
    let period: BillingView["period"] = null;
    // A business that has left pays for the month it left in, and none that start on or after
    // that day (decision 019): such a month isn't shown as one to be charged for.
    const leftOn =
      tenant.cancellation_requested_at === null ? null : ukDateOf(tenant.cancellation_requested_at);
    const anchor = tenant.billing_start_date;
    const current =
      anchor !== null && tenant.status !== "demo" ? currentBillingPeriod(anchor, now) : null;
    if (current && (leftOn === null || current.periodStart < leftOn)) {
      const usage = (
        await client.query<{ billable_seconds: number }>(
          "SELECT billable_seconds::int FROM usage_periods WHERE tenant_id = $1 AND period_start = $2",
          [tenantId, current.periodStart],
        )
      ).rows[0];
      const billableSeconds = usage?.billable_seconds ?? 0;
      // Suspended from the month's first moment, and still (or to its end): the month-end
      // charge (jobs/charge-periods.ts) bills nothing for it, so neither does the month so far.
      const suspendedThroughout = (
        await client.query<{ suspended: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM tenant_suspensions
             WHERE tenant_id = $1
               AND started_at <= ($2::date)::timestamp AT TIME ZONE 'Europe/London'
               AND (ended_at IS NULL OR ended_at >= ($3::date)::timestamp AT TIME ZONE 'Europe/London')
           ) AS suspended`,
          [tenantId, current.periodStart, current.periodEnd],
        )
      ).rows[0]!.suspended;
      // VAT isn't added: the Account page shows prices before VAT, as the plan is sold.
      const charge = (seconds: number) =>
        chargeFor({
          plan,
          period: current,
          isPilot: tenant.is_pilot,
          billableSeconds: seconds,
          vat: null,
          suspendedThroughout,
        });
      const soFar = charge(billableSeconds);
      const today = ukDateOf(now);
      const heading = suspendedThroughout
        ? null
        : projectedSeconds(billableSeconds, monthProgress(current, today));
      const projected = heading === null ? null : charge(heading);
      // Each day's calls, by UK date. Only the month's own: the go-live day's test call is
      // taken back off by daysOfMonth, so the days add up to the usage above.
      const stored = await client.query<{ day: string; seconds: number }>(
        `SELECT to_char(started_at AT TIME ZONE 'Europe/London', 'YYYY-MM-DD') AS day,
                sum(billable_seconds)::int AS seconds
         FROM calls
         WHERE tenant_id = $1 AND started_at >= $2 AND started_at < $3 AND billable_seconds > 0
         GROUP BY 1`,
        [tenantId, startOfUkDate(current.periodStart), startOfUkDate(current.periodEnd)],
      );
      period = {
        start: current.periodStart,
        end: current.periodEnd,
        month: current.index + 1,
        feePence: soFar.feePence,
        billableSeconds,
        suspendedThroughout,
        soFar: {
          overageMinutes: soFar.overageMinutes,
          overagePence: soFar.overagePence,
          totalPence: soFar.subtotalPence,
        },
        projected:
          heading === null || projected === null
            ? null
            : {
                minutes: Math.ceil(heading / 60),
                overagePence: projected.overagePence,
                totalPence: projected.subtotalPence,
              },
        days: daysOfMonth(
          current.periodStart,
          today,
          new Map(stored.rows.map((row) => [row.day, row.seconds])),
          billableSeconds,
        ),
      };
    }
    const directDebit = await directDebitState(client, tenantId);
    const charges = (
      await client.query<{
        period_start: string;
        period_end: string;
        lines: { description: string; pence: number }[];
        vat_pence: number;
        total_pence: number;
        status: string;
        charge_date: string | null;
        invoice_number: number | null;
      }>(
        `SELECT period_start::text, period_end::text, lines, vat_pence, total_pence, status,
                charge_date::text, invoice_number
         FROM billing_charges WHERE tenant_id = $1 ORDER BY period_start DESC LIMIT 12`,
        [tenantId],
      )
    ).rows;
    return {
      available,
      plan: {
        name: plan.name,
        monthlyPence: plan.monthlyPence,
        includedMinutes: plan.includedMinutes,
        overagePencePerMinute: plan.overagePencePerMinute,
      },
      isPilot: tenant.is_pilot,
      period,
      leftOn,
      directDebit: {
        status: directDebit.status,
        since: directDebit.since?.toISOString() ?? null,
        endReason: directDebit.endReason,
      },
      charges: charges.map((charge) => ({
        periodStart: charge.period_start,
        periodEnd: charge.period_end,
        lines: charge.lines,
        vatPence: charge.vat_pence,
        totalPence: charge.total_pence,
        status: charge.status,
        chargeDate: charge.charge_date,
        invoiceNumber:
          charge.invoice_number === null ? null : invoiceNumberText(charge.invoice_number),
      })),
      billingAddress: tenant.billing_address,
    } satisfies BillingView;
  });
}

/**
 * Sets (or with null, clears) the address a business's VAT invoices are made out to. Inside its
 * own row-level security; the change is audited, without the address (it's personal data for a
 * sole trader). Returns false if there's no such business.
 */
export async function setBillingAddress(
  pool: pg.Pool,
  tenantId: string,
  address: string | null,
  actorUserId: string,
): Promise<boolean> {
  return withTenant(pool, tenantId, async (client) => {
    const updated = await client.query("UPDATE tenants SET billing_address = $2 WHERE id = $1", [
      tenantId,
      address,
    ]);
    if (updated.rowCount !== 1) return false;
    await client.query(
      "INSERT INTO audit_log (tenant_id, actor_user_id, action, details) VALUES ($1, $2, 'billing.address-changed', $3)",
      [tenantId, actorUserId, { cleared: address === null }],
    );
    return true;
  });
}
