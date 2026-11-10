// Commercial settings (BUILD_PLAN Appendix D; decision 019): data, not code, so a price change
// is an edit here. All money is integer pence, ex VAT. Shared so the dashboard can show a
// business what it's paying without asking the API.

export interface Plan {
  id: "ai_answering";
  name: string;
  /** The monthly fee, pence ex VAT. */
  monthlyPence: number;
  /** Billable minutes a month before overage applies. */
  includedMinutes: number;
  /** Pence per whole minute over the included minutes, rounded up once a period. */
  overagePencePerMinute: number;
}

/** The one plan there is. */
export const AI_ANSWERING_PLAN: Plan = {
  id: "ai_answering",
  name: "AI Answering",
  monthlyPence: 9900,
  includedMinutes: 200,
  overagePencePerMinute: 20,
};

/**
 * The pilot: the first month free, then a reduced fee for a few months, then the plan's own.
 * Included minutes and overage are the plan's throughout: the pilot waives the fee, not usage.
 */
export const PILOT = {
  freeMonths: 1,
  reducedMonths: 3,
  reducedMonthlyPence: 4900,
} as const;

/** UK standard rate, applied only once a VAT registration is in force (core/billing.ts). */
export const VAT_RATE_PERCENT = 20;

/** The fee for a business's nth billing month (0 = the first), given whether it's a pilot. */
export function monthlyFeePence(plan: Plan, periodIndex: number, isPilot: boolean): number {
  if (!isPilot) return plan.monthlyPence;
  if (periodIndex < PILOT.freeMonths) return 0;
  if (periodIndex < PILOT.freeMonths + PILOT.reducedMonths) return PILOT.reducedMonthlyPence;
  return plan.monthlyPence;
}
