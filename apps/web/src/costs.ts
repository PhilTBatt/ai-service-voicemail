// What the money screens show, worked out from what the API sent: the Account page's month so
// far (its bill in parts, its minutes, each day's calls) and the Admin page's costs (each
// supplier's use, change and share). Pure, so the words and the sums are tested without a
// browser (costs.test.ts); the pages only lay them out.
import type {
  BillingView,
  CostRowView,
  ServiceCostView,
  ServiceCostsView,
  TrendView,
} from "@callmate/shared";
import type { Tone } from "./design/tone.ts";
import { formatDurationWords, formatPence } from "./format.ts";
import { addDays, formatDate } from "./time.ts";

type Period = NonNullable<BillingView["period"]>;
type Plan = BillingView["plan"];

/** One part of a bar: its share is of the whole bar, in percent. */
export interface BarPart {
  key: string;
  label: string;
  /** What the legend says beside the label. */
  value: string;
  percent: number;
  /** Which chart colour it wears: the same thing is the same colour everywhere. */
  series: 1 | 2;
}

/** Percent of a whole, to one decimal place; nothing of nothing is 0. */
function share(part: number, whole: number): number {
  return whole <= 0 ? 0 : Math.round((part / whole) * 1000) / 10;
}

const minutes = (count: number) => `${count} ${count === 1 ? "minute" : "minutes"}`;

/** The month's bill so far in its parts: the plan, and any extra minutes. */
export function billParts(period: Period): { total: string; summary: string; parts: BarPart[] } {
  const { feePence, soFar } = period;
  const parts: BarPart[] = [
    {
      key: "plan",
      label: "Plan",
      value: formatPence(feePence),
      percent: soFar.totalPence === 0 ? 0 : share(feePence, soFar.totalPence),
      series: 1,
    },
    {
      key: "extra",
      label: "Extra minutes",
      value: formatPence(soFar.overagePence),
      percent: share(soFar.overagePence, soFar.totalPence),
      series: 2,
    },
  ];
  return {
    total: formatPence(soFar.totalPence),
    summary: period.suspendedThroughout
      ? "Suspended since before this month began, so nothing is charged for it while that lasts."
      : soFar.overageMinutes === 0
        ? `${formatPence(feePence)} for the plan. No extra minutes so far.`
        : `${formatPence(feePence)} for the plan, plus ${formatPence(soFar.overagePence)} for ${minutes(soFar.overageMinutes)} over the included ones.`,
    parts,
  };
}

/**
 * The month's minutes against the plan: the included ones used, and any over them. The bar is
 * as long as the included minutes, or the minutes used once they pass them, so going over
 * shows as the second part growing rather than the bar overflowing.
 */
export function minuteParts(
  period: Period,
  plan: Plan,
): { used: number; label: string; left: string; parts: BarPart[] } {
  const used = Math.ceil(period.billableSeconds / 60);
  const included = Math.min(used, plan.includedMinutes);
  const extra = Math.max(0, used - plan.includedMinutes);
  const scale = Math.max(plan.includedMinutes, used);
  return {
    used,
    label: `${used} of ${plan.includedMinutes} included minutes used`,
    left:
      extra > 0
        ? `${minutes(extra)} over, at ${plan.overagePencePerMinute}p each`
        : `${minutes(plan.includedMinutes - used)} left`,
    parts: [
      {
        key: "included",
        label: "Included",
        value: minutes(included),
        percent: share(included, scale),
        series: 1,
      },
      {
        key: "extra",
        label: "Extra",
        value: minutes(extra),
        percent: share(extra, scale),
        series: 2,
      },
    ],
  };
}

/** Where the month is heading, in a sentence; null while it's too early to say. */
export function projectionText(period: Period): string | null {
  if (period.projected === null) return null;
  const { minutes: heading, overagePence, totalPence } = period.projected;
  const lastDay = formatDate(addDays(period.end, -1));
  return overagePence === 0
    ? `At this rate: about ${minutes(heading)} by ${lastDay}, inside the plan, so ${formatPence(totalPence)}.`
    : `At this rate: about ${minutes(heading)} by ${lastDay}, so about ${formatPence(totalPence)} (${formatPence(overagePence)} of it extra minutes).`;
}

/** One day of the month's calls, as a column: its height is against the busiest day. */
export interface DayColumn {
  date: string;
  /** "14 Nov 2026: 2 min 30 sec", for the tooltip. */
  label: string;
  day: string;
  /** "2 min 30 sec", for the table. */
  time: string;
  percent: number;
}

/**
 * Each day's billable time as it was, to the second: the month is rounded up to whole minutes
 * once, at its end, so rounding each day up would add to more than the month (ten 61-second
 * days are 20 minutes that way, and 11 billed).
 */
export function dayColumns(days: Period["days"]): DayColumn[] {
  const busiest = Math.max(0, ...days.map((day) => day.billableSeconds));
  return days.map((day) => {
    const name = formatDate(day.date);
    const time = day.billableSeconds === 0 ? "None" : formatDurationWords(day.billableSeconds);
    return {
      date: day.date,
      day: name,
      time,
      label: `${name}: ${time}`,
      percent: share(day.billableSeconds, busiest),
    };
  });
}

/** "+£1.20", "-£0.40" or "No change", and whether that's worth a colour. */
export function penceChange(now: number, next: number): { label: string; tone: Tone } {
  const change = next - now;
  if (change === 0) return { label: "No change", tone: "neutral" };
  return change > 0
    ? { label: `+${formatPence(change)}`, tone: "warning" }
    : { label: formatPence(change), tone: "success" };
}

/** A trend's change as people read it: "+50%", "-20%", "New" from nothing, a dash for none. */
export function rateLabel(trend: TrendView): string {
  if (trend.ratePercent === null) return trend.last > 0 ? "New" : "–";
  if (trend.ratePercent === 0) return "No change";
  return `${trend.ratePercent > 0 ? "+" : ""}${trend.ratePercent}%`;
}

/** What a supplier's plan has used: "14 of 100 emails", "2 numbers", "£0.30 of £400.00". */
export function usageLabel(usage: NonNullable<ServiceCostView["usage"]>): string {
  const show = (count: number) =>
    usage.unit === "pence" ? formatPence(count) : count.toLocaleString("en-GB");
  // "1 number", not "1 numbers": every unit here is a plain plural.
  const one = usage.limit === null && usage.used === 1;
  const unit = usage.unit === "pence" ? "" : ` ${one ? usage.unit.replace(/s$/, "") : usage.unit}`;
  return usage.limit === null
    ? `${show(usage.used)}${unit}`
    : `${show(usage.used)} of ${show(usage.limit)}${unit}`;
}

/** The suppliers by what they cost, dearest first, each bar against the dearest. */
export function rankedServices(
  services: ServiceCostView[],
): { id: string; name: string; value: string; percent: number }[] {
  const dearest = Math.max(0, ...services.map((service) => service.pence.now));
  return [...services]
    .sort((a, b) => b.pence.now - a.pence.now || a.name.localeCompare(b.name))
    .map((service) => ({
      id: service.id,
      name: service.name,
      value: formatPence(service.pence.now),
      percent: share(service.pence.now, dearest),
    }));
}

/** Every tier warning, with the supplier it's about: costs going up first, then savings. */
export function tierWarnings(
  services: ServiceCostView[],
): { id: string; name: string; direction: "up" | "down"; text: string }[] {
  return services
    .flatMap((service) =>
      service.warnings.map((warning, index) => ({
        id: `${service.id}-${index}`,
        name: service.name,
        ...warning,
      })),
    )
    .sort((a, b) => Number(a.direction === "down") - Number(b.direction === "down"));
}

/** "14.72p" from 1472 hundredths of a penny; a dash before there are calls to divide by. */
export function perMinuteLabel(hundredths: number | null): string {
  return hundredths === null ? "–" : `${(hundredths / 100).toFixed(2)}p`;
}

/** The headline figures across the top of the Costs tab. */
export function costHeadlines(
  totals: ServiceCostsView["totals"],
): { key: string; label: string; value: string; hint: string; tone?: Tone }[] {
  const change = penceChange(totals.nowPence, totals.nextPence);
  const businesses = `${totals.payingBusinesses} paying ${totals.payingBusinesses === 1 ? "business" : "businesses"}`;
  return [
    {
      key: "now",
      label: "Costs, last 30 days",
      value: formatPence(totals.nowPence),
      hint: "Every supplier, estimated",
    },
    {
      key: "next",
      label: "Heading for, next 30 days",
      value: formatPence(totals.nextPence),
      hint: change.label === "No change" ? "No change expected" : `${change.label} on the last 30`,
    },
    {
      key: "income",
      label: "Income, billing months so far",
      value: formatPence(totals.incomePence),
      hint: `${businesses}, before VAT`,
    },
    {
      key: "margin",
      label: "Income less costs",
      value: formatPence(totals.marginPence),
      hint: totals.marginPence < 0 ? "Costs are ahead of income" : "Income is ahead of costs",
      tone: totals.marginPence < 0 ? "danger" : "success",
    },
    {
      key: "minute",
      label: "Cost of a call minute",
      value: perMinuteLabel(totals.perMinuteHundredths),
      hint: "Calls, texts and summaries only",
    },
  ];
}

/** What a business's month has made over its costs so far; null for one that doesn't pay. */
export function businessMargin(row: CostRowView): number | null {
  return row.billPence === null ? null : row.billPence - row.pence.total;
}

/** How a supplier's own figure compares with our estimate, in words. */
export function estimateGap(actualPence: number, estimatePence: number): string {
  const gap = actualPence - estimatePence;
  if (gap === 0) return "the same as our estimate";
  return gap > 0
    ? `${formatPence(gap)} more than our estimate`
    : `${formatPence(-gap)} less than our estimate`;
}

/** A share of what was sent, to one decimal place: "7.1%"; nothing of nothing is "0%". */
export function percentOf(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  return `${Math.round((part / whole) * 1000) / 10}%`;
}

/**
 * Postmark's count beside ours, in a sentence. Ours misses the alert emails (and anything else
 * the server sends that isn't recorded), so Postmark's is the one the plan counts.
 */
export function emailCountText(sent: number, ourCount: number): string {
  const more = sent - ourCount;
  const counted = `Our records count ${ourCount}`;
  if (more > 0) {
    return `${counted}: the other ${more} ${more === 1 ? "is an alert email" : "are alert emails"} or anything else we don't record.`;
  }
  if (more < 0) {
    return `${counted}: more than Postmark's, which can happen at the edges of the 30 days (Postmark counts in US Eastern time).`;
  }
  return `${counted}, the same.`;
}
