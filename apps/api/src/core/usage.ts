// Usage maths (BUILD_PLAN Steps 5 and 12). Pure functions; all money is integer pence.

/** Calls shorter than this aren't billed: hang-ups, wrong numbers, dead air. */
export const MIN_BILLABLE_SECONDS = 5;

export function billableSeconds(durationSeconds: number): number {
  return durationSeconds < MIN_BILLABLE_SECONDS ? 0 : Math.floor(durationSeconds);
}

/**
 * The calendar month a call falls in, in UK local time. Step 12 may move to rolling
 * 30-day periods per tenant; the table stores explicit start and end dates either way.
 */
export function usagePeriodFor(at: Date): { periodStart: string; periodEnd: string } {
  const local = Temporal.Instant.fromEpochMilliseconds(at.getTime()).toZonedDateTimeISO(
    "Europe/London",
  );
  const start = Temporal.PlainDate.from({ year: local.year, month: local.month, day: 1 });
  return { periodStart: start.toString(), periodEnd: start.add({ months: 1 }).toString() };
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
