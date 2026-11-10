// Billing maths (BUILD_PLAN Step 12; decision 019). Pure functions; all money is integer
// pence. A business's billing periods are months on the anniversary of the day it went live
// (its billing_start_date): the 14th to the 13th, charged once a month. The charge for a
// period is the month's fee (the pilot's shape or the plan's), plus overage on the period's
// billable seconds rounded up to whole minutes once, plus VAT when a registration is in force.
import { monthlyFeePence, VAT_RATE_PERCENT, type Plan } from "@callmate/shared";
import { anniversaryPeriod, overagePence } from "./usage.ts";

export interface BillingPeriod {
  /** YYYY-MM-DD, UK dates. The period is [periodStart, periodEnd). */
  periodStart: string;
  periodEnd: string;
  /** 0 for the first month after going live, 1 for the second, and so on: the pilot counts by it. */
  index: number;
}

/**
 * The billing period containing `at` for a business whose periods start on `anchor` (its
 * billing_start_date, a UK date). Each period runs to the same day the next month; an anchor
 * on the 31st falls back to the last day of shorter months (Temporal's month arithmetic).
 * Throws for a time before the anchor: nothing is billable before a business went live.
 */
export function billingPeriodFor(anchor: string, at: Date): BillingPeriod {
  const start = Temporal.PlainDate.from(anchor);
  const day = Temporal.Instant.fromEpochMilliseconds(at.getTime())
    .toZonedDateTimeISO("Europe/London")
    .toPlainDate();
  if (Temporal.PlainDate.compare(day, start) < 0) {
    throw new Error(`${day.toString()} is before the billing start date ${anchor}`);
  }
  const period = anniversaryPeriod(start, day);
  return {
    periodStart: period.start.toString(),
    periodEnd: period.end.toString(),
    index: period.index,
  };
}

/**
 * The period that ended on `periodEnd` (a UK date), or null if no period of this business
 * ends that day: what the end-of-period job charges for, the morning after.
 */
export function billingPeriodEndingOn(anchor: string, periodEnd: string): BillingPeriod | null {
  const start = Temporal.PlainDate.from(anchor);
  const end = Temporal.PlainDate.from(periodEnd);
  if (Temporal.PlainDate.compare(end, start) <= 0) return null;
  // The period containing the day before `end` is the only one that can end on it.
  const period = anniversaryPeriod(start, end.subtract({ days: 1 }));
  if (Temporal.PlainDate.compare(period.end, end) !== 0) return null;
  return { periodStart: period.start.toString(), periodEnd, index: period.index };
}

export interface VatRegistration {
  number: string;
  /** The UK date from which VAT is charged. */
  from: string;
}

export interface ChargeInput {
  plan: Plan;
  period: BillingPeriod;
  isPilot: boolean;
  billableSeconds: number;
  /** Null while the business isn't VAT registered. */
  vat: VatRegistration | null;
}

export interface Charge {
  /** The month's fee: the plan's, or the pilot's for that month. */
  feePence: number;
  /** Minutes over the included ones, rounded up once for the period. */
  overageMinutes: number;
  overagePence: number;
  subtotalPence: number;
  /** 0 while VAT isn't charged. */
  vatRatePercent: number;
  vatPence: number;
  totalPence: number;
  /** For the receipt: one line per part, in pence ex VAT. */
  lines: { description: string; pence: number }[];
}

/** What a business owes for a period. Integer pence throughout; VAT rounded once, on the subtotal. */
export function chargeFor({ plan, period, isPilot, billableSeconds, vat }: ChargeInput): Charge {
  if (!Number.isInteger(billableSeconds) || billableSeconds < 0) {
    throw new Error("billableSeconds must be a whole, non-negative number");
  }
  const feePence = monthlyFeePence(plan, period.index, isPilot);
  const overageMinutes = Math.max(0, Math.ceil(billableSeconds / 60) - plan.includedMinutes);
  const overage = overagePence(billableSeconds, plan.includedMinutes, plan.overagePencePerMinute);
  const subtotalPence = feePence + overage;
  const vatOn = vat !== null && Temporal.PlainDate.compare(period.periodStart, vat.from) >= 0;
  const vatRatePercent = vatOn ? VAT_RATE_PERCENT : 0;
  const vatPence = Math.round((subtotalPence * vatRatePercent) / 100);
  const lines = [
    {
      description:
        isPilot && feePence !== plan.monthlyPence
          ? `${plan.name} plan, pilot month ${period.index + 1}`
          : `${plan.name} plan`,
      pence: feePence,
    },
    ...(overageMinutes > 0
      ? [
          {
            description: `${overageMinutes} minutes over the ${plan.includedMinutes} included, at ${plan.overagePencePerMinute}p a minute`,
            pence: overage,
          },
        ]
      : []),
  ];
  return {
    feePence,
    overageMinutes,
    overagePence: overage,
    subtotalPence,
    vatRatePercent,
    vatPence,
    totalPence: subtotalPence + vatPence,
    lines,
  };
}

/** "£99.00" from 9900: for receipts and the dashboard. */
export function formatPence(pence: number): string {
  const sign = pence < 0 ? "-" : "";
  const abs = Math.abs(pence);
  return `${sign}£${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
