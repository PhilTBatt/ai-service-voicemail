// What a business sees of its billing (BUILD_PLAN Step 12; decision 019): the plan, the
// current billing month and its billable time so far, and its Direct Debit. Read inside the
// business's own transaction.
import { AI_ANSWERING_PLAN, monthlyFeePence, type BillingView } from "@callmate/shared";
import type pg from "pg";
import { billingPeriodFor, ukDateOf } from "../core/billing.ts";
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
      }>(
        "SELECT is_pilot, billing_start_date::text, status, cancellation_requested_at FROM tenants WHERE id = $1",
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
    const current =
      tenant.billing_start_date !== null && tenant.status !== "demo"
        ? billingPeriodFor(tenant.billing_start_date, now)
        : null;
    if (current && (leftOn === null || current.periodStart < leftOn)) {
      const usage = (
        await client.query<{ billable_seconds: number }>(
          "SELECT billable_seconds::int FROM usage_periods WHERE tenant_id = $1 AND period_start = $2",
          [tenantId, current.periodStart],
        )
      ).rows[0];
      period = {
        start: current.periodStart,
        end: current.periodEnd,
        month: current.index + 1,
        feePence: monthlyFeePence(plan, current.index, tenant.is_pilot),
        billableSeconds: usage?.billable_seconds ?? 0,
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
      }>(
        `SELECT period_start::text, period_end::text, lines, vat_pence, total_pence, status,
                charge_date::text
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
      })),
    } satisfies BillingView;
  });
}
