// Billing maths (BUILD_PLAN Step 12; decision 019). Pure functions; all money is integer
// pence. A business's billing periods are months on the anniversary of the day it went live
// (its billing_start_date): the 14th to the 13th, charged once a month. The charge for a
// period is the month's fee (the pilot's shape or the plan's), plus overage on the period's
// billable seconds rounded up to whole minutes once, plus VAT when a registration is in force.
import { monthlyFeePence, VAT_RATE_PERCENT, type Plan } from "@callmate/shared";
import { anniversaryPeriod, overagePence, startOfUkDate } from "./usage.ts";

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
 * The billing month a business is in at `now`. As billingPeriodFor, except on go-live day:
 * the billing start date is the database's UK date when the business went live, and `now` is
 * this server's clock, so a moment behind the database's it's still the day before here. That's
 * the first month, not an error.
 */
export function currentBillingPeriod(anchor: string, now: Date): BillingPeriod {
  return billingPeriodFor(anchor, ukDateOf(now) < anchor ? startOfUkDate(anchor) : now);
}

/** How long a billing month is in UK days, and how many of them have begun by `today` (a UK date). */
export interface MonthProgress {
  days: number;
  /** Today included; 0 before the month starts. */
  daysSoFar: number;
}

export function monthProgress(
  period: Pick<BillingPeriod, "periodStart" | "periodEnd">,
  today: string,
): MonthProgress {
  const start = Temporal.PlainDate.from(period.periodStart);
  const days = start.until(Temporal.PlainDate.from(period.periodEnd), { largestUnit: "days" }).days;
  const begun = start.until(Temporal.PlainDate.from(today), { largestUnit: "days" }).days + 1;
  return { days, daysSoFar: Math.min(days, Math.max(0, begun)) };
}

/**
 * The day of the month from which the Account page says where the month is heading. Before it,
 * one busy day swings the estimate wildly: a single 10-minute call on day 1 "projects" 300
 * minutes and a bill over the plan.
 */
export const PROJECTION_FROM_DAY = 7;

/**
 * The month's billable seconds if calls carry on at the rate so far, or null before
 * PROJECTION_FROM_DAY. A straight line: an estimate, never what's charged.
 */
export function projectedSeconds(billableSeconds: number, progress: MonthProgress): number | null {
  if (progress.daysSoFar < PROJECTION_FROM_DAY) return null;
  return Math.round((billableSeconds * progress.days) / progress.daysSoFar);
}

/**
 * Billable seconds on each UK day of a billing month, from its first day to `today`, from the
 * calls stored on each day (`stored`, by date). Only calls from the moment a business went live
 * are billed, so on go-live day the calls before that moment (its test call) are stored but not
 * counted: the days then add up to more than the month's usage (`billedSeconds`). The excess is
 * taken off the earliest days, where those calls are, so the days always add up to what's billed.
 */
export function daysOfMonth(
  periodStart: string,
  today: string,
  stored: ReadonlyMap<string, number>,
  billedSeconds: number,
): { date: string; billableSeconds: number }[] {
  let excess = [...stored.values()].reduce((total, seconds) => total + seconds, 0) - billedSeconds;
  const days: { date: string; billableSeconds: number }[] = [];
  const last = Temporal.PlainDate.from(today);
  for (
    let day = Temporal.PlainDate.from(periodStart);
    Temporal.PlainDate.compare(day, last) <= 0;
    day = day.add({ days: 1 })
  ) {
    let seconds = stored.get(day.toString()) ?? 0;
    if (excess > 0) {
      const cut = Math.min(excess, seconds);
      seconds -= cut;
      excess -= cut;
    }
    days.push({ date: day.toString(), billableSeconds: seconds });
  }
  return days;
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

/**
 * The billing months that have ended by `today` (a UK date), oldest first: each is charged the
 * morning after it ends. A business that has asked to leave (`leftOn`, a UK date) is charged for
 * every month that began before that day, the one it left in included, and none after.
 */
export function endedPeriods(
  anchor: string,
  today: string,
  leftOn: string | null,
): BillingPeriod[] {
  const start = Temporal.PlainDate.from(anchor);
  const until = Temporal.PlainDate.from(today);
  const left = leftOn === null ? null : Temporal.PlainDate.from(leftOn);
  const periods: BillingPeriod[] = [];
  for (let index = 0; ; index += 1) {
    const periodStart = start.add({ months: index });
    const periodEnd = start.add({ months: index + 1 });
    if (Temporal.PlainDate.compare(periodEnd, until) > 0) break;
    if (left !== null && Temporal.PlainDate.compare(periodStart, left) >= 0) break;
    periods.push({ periodStart: periodStart.toString(), periodEnd: periodEnd.toString(), index });
  }
  return periods;
}

/** The UK calendar date at an instant, YYYY-MM-DD. */
export function ukDateOf(at: Date): string {
  return Temporal.Instant.fromEpochMilliseconds(at.getTime())
    .toZonedDateTimeISO("Europe/London")
    .toPlainDate()
    .toString();
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
  /**
   * Suspended from the first moment of the period to its end: no service, so nothing is
   * charged (Phil, 2026-11-11). A month with any day of service is charged in full.
   */
  suspendedThroughout?: boolean;
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
export function chargeFor({
  plan,
  period,
  isPilot,
  billableSeconds,
  vat,
  suspendedThroughout = false,
}: ChargeInput): Charge {
  if (!Number.isInteger(billableSeconds) || billableSeconds < 0) {
    throw new Error("billableSeconds must be a whole, non-negative number");
  }
  if (suspendedThroughout) {
    return {
      feePence: 0,
      overageMinutes: 0,
      overagePence: 0,
      subtotalPence: 0,
      vatRatePercent: 0,
      vatPence: 0,
      totalPence: 0,
      lines: [{ description: "Suspended for the whole month: no charge", pence: 0 }],
    };
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
            description: `${overageMinutes} ${overageMinutes === 1 ? "minute" : "minutes"} over the ${plan.includedMinutes} included, at ${plan.overagePencePerMinute}p a minute`,
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
