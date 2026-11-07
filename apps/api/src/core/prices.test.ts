import { describe, expect, it } from "vitest";
import { CURRENT_PRICES, describePrices, poundsToPence } from "./prices.ts";

describe("poundsToPence", () => {
  it("rounds a supplier's price to whole pence, half up", () => {
    expect(poundsToPence("0.86917")).toBe(87);
    expect(poundsToPence("0.8649")).toBe(86);
    expect(poundsToPence("0.865")).toBe(87);
    expect(poundsToPence("12")).toBe(1200);
    expect(poundsToPence("1.5")).toBe(150);
    expect(poundsToPence(" 2.04066 ")).toBe(204);
  });

  it("refuses anything that isn't an amount", () => {
    expect(() => poundsToPence("£0.87")).toThrow("Not an amount of money");
    expect(() => poundsToPence("-1")).toThrow("Not an amount of money");
  });
});

describe("describePrices", () => {
  it("says, in words, every rate the estimate uses", () => {
    const text = describePrices(CURRENT_PRICES).join("\n");
    for (const rate of [
      CURRENT_PRICES.smsSegmentGbp,
      CURRENT_PRICES.inboundCallPerMinuteGbp,
      CURRENT_PRICES.sipPerMinuteUsd,
      CURRENT_PRICES.localNumberPerMonthGbp,
      CURRENT_PRICES.gbpPerUsd,
    ]) {
      expect(text).toContain(rate);
    }
  });
});
