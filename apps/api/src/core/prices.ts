// What CallMate's suppliers charge: for the admin screen's cost estimates, and the evals'
// cost cap. Estimates, not bills: suppliers change prices and exchange rates move. The money
// prices are decimal strings, so the estimate is summed exactly in the database (numeric) and
// rounded to whole pence once, never in floating point (CLAUDE.md).

/** Twilio's prices for this account, which it prices in pounds. Read from its Pricing API on 2026-11-07. */
export const TWILIO_PRICES_GBP = {
  /** A text to a UK mobile, per segment (GET pricing.twilio.com/v1/Messaging/Countries/GB). */
  smsSegment: "0.042325",
  /** A call to a UK local number, per minute (GET pricing.twilio.com/v2/Voice/Countries/GB). */
  inboundCallPerMinute: "0.007558",
  /** Renting a UK local number, per month (GET pricing.twilio.com/v1/PhoneNumbers/Countries/GB). */
  localNumberPerMonth: "0.86917",
} as const;

/**
 * Twilio's SIP interface, per minute: the leg that hands each answered call to the voice
 * platform, charged on top of the incoming call. https://www.twilio.com/en-us/voice/pricing/gb
 * ("current as of August 2026"), in dollars.
 */
export const TWILIO_SIP_PER_MINUTE_USD = "0.004";

/** Pounds per US dollar, for the costs billed in dollars. Deliberately on the high side. */
export const GBP_PER_USD = "0.8";

/** Published list prices, US dollars per million tokens, as of 2026-11-07. */
export const MODEL_PRICES_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "fake-model": { input: 0, output: 0 },
};

/** Everything the cost estimate needs, so tests can pass their own. */
export interface CostPrices {
  gbpPerUsd: string;
  smsSegmentGbp: string;
  inboundCallPerMinuteGbp: string;
  sipPerMinuteUsd: string;
  localNumberPerMonthGbp: string;
  /** Model name → US dollars per million tokens. */
  models: Record<string, { input: number; output: number }>;
}

export const CURRENT_PRICES: CostPrices = {
  gbpPerUsd: GBP_PER_USD,
  smsSegmentGbp: TWILIO_PRICES_GBP.smsSegment,
  inboundCallPerMinuteGbp: TWILIO_PRICES_GBP.inboundCallPerMinute,
  sipPerMinuteUsd: TWILIO_SIP_PER_MINUTE_USD,
  localNumberPerMonthGbp: TWILIO_PRICES_GBP.localNumberPerMonth,
  models: MODEL_PRICES_USD_PER_MTOK,
};

/**
 * A pounds amount as a supplier writes it ("0.86917") to whole pence, rounding half up, using
 * string arithmetic so no floating point is involved: 0.86917 → 87, 0.8649 → 86.
 */
export function poundsToPence(amount: string): number {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!match) throw new Error(`Not an amount of money: "${amount}"`);
  const decimals = (match[2] ?? "").padEnd(3, "0");
  const roundUp = Number(decimals[2]) >= 5 ? 1 : 0;
  return Number(match[1]) * 100 + Number(decimals.slice(0, 2)) + roundUp;
}

/** The assumptions, in words, for the admin screen to print under the figures. */
export function describePrices(prices: CostPrices): string[] {
  return [
    `Voice platform: Retell's own cost for each call, in dollars at £${prices.gbpPerUsd} per $1.`,
    `AI summaries: tokens at the model's list price, at £${prices.gbpPerUsd} per $1.`,
    `Texts: £${prices.smsSegmentGbp} a segment (Twilio, this account, 7 Nov 2026).`,
    `Phone minutes: each call rounded up to whole minutes, at £${prices.inboundCallPerMinuteGbp} a minute for the incoming call, plus $${prices.sipPerMinuteUsd} a minute for the leg to the voice platform when the assistant answered.`,
    `Number: £${prices.localNumberPerMonthGbp} a month for a local number.`,
    "Email isn't counted: Postmark's free 100 a month covers it for now.",
  ];
}
