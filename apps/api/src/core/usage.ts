// Usage maths (BUILD_PLAN Steps 5 and 12). Pure functions; all money is integer pence.

/** Calls shorter than this aren't billed: hang-ups, wrong numbers, dead air. */
export const MIN_BILLABLE_SECONDS = 5;

export function billableSeconds(durationSeconds: number): number {
  return durationSeconds < MIN_BILLABLE_SECONDS ? 0 : Math.floor(durationSeconds);
}

/**
 * The usage period a call falls in, in UK local time. For a business that has gone live,
 * periods are months on the anniversary of its billing start date (decision 019), so its
 * usage lines up with what it's charged for. Without one (a business still onboarding, a
 * demo, or a call from before it went live), the UK calendar month. The table stores explicit
 * start and end dates either way.
 */
export function usagePeriodFor(
  at: Date,
  billingStartDate: string | null = null,
): { periodStart: string; periodEnd: string } {
  const local = Temporal.Instant.fromEpochMilliseconds(at.getTime()).toZonedDateTimeISO(
    "Europe/London",
  );
  if (billingStartDate !== null) {
    const anchor = Temporal.PlainDate.from(billingStartDate);
    if (Temporal.PlainDate.compare(local.toPlainDate(), anchor) >= 0) {
      const period = anniversaryPeriod(anchor, local.toPlainDate());
      return { periodStart: period.start.toString(), periodEnd: period.end.toString() };
    }
  }
  const start = Temporal.PlainDate.from({ year: local.year, month: local.month, day: 1 });
  return { periodStart: start.toString(), periodEnd: start.add({ months: 1 }).toString() };
}

/**
 * The anniversary month containing `day`, counted from `anchor`: [anchor + n months, anchor +
 * n+1 months). An anchor on the 31st falls back to the last day of shorter months (Temporal's
 * month arithmetic), so the month difference can over-count by one around them.
 */
export function anniversaryPeriod(
  anchor: Temporal.PlainDate,
  day: Temporal.PlainDate,
): { start: Temporal.PlainDate; end: Temporal.PlainDate; index: number } {
  let index = Math.max(0, anchor.until(day, { largestUnit: "months" }).months);
  while (Temporal.PlainDate.compare(anchor.add({ months: index }), day) > 0) index -= 1;
  while (Temporal.PlainDate.compare(anchor.add({ months: index + 1 }), day) <= 0) index += 1;
  return { start: anchor.add({ months: index }), end: anchor.add({ months: index + 1 }), index };
}

/**
 * Overage for a period: seconds accumulate across the period and are rounded UP to whole
 * minutes once, not per call (BUILD_PLAN Step 12). Returns pence.
 */
export function overagePence(
  periodBillableSeconds: number,
  includedMinutes: number,
  overagePencePerMinute: number,
): number {
  const minutes = Math.ceil(periodBillableSeconds / 60);
  return Math.max(0, minutes - includedMinutes) * overagePencePerMinute;
}

/** The instant a UK calendar date (YYYY-MM-DD) begins: midnight UK time, as UTC. */
export function startOfUkDate(date: string): Date {
  const start = Temporal.PlainDate.from(date).toZonedDateTime({ timeZone: "Europe/London" });
  return new Date(start.epochMilliseconds);
}
