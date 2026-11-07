import { describe, expect, it } from "vitest";
import { CostCapExceededError, CostMeter } from "./cost.ts";

describe("CostMeter", () => {
  it("estimates pence from list prices, rounding up", () => {
    // Haiku 5.5: $0.10 in, $0.50 out per million tokens; at £0.80 per dollar.
    const meter = new CostMeter({ model: "claude-haiku-5-5", capPence: 100 });
    meter.add({ inputTokens: 1_000_000, outputTokens: 0 });
    expect(meter.estimatedPence).toBe(8);
    meter.add({ inputTokens: 0, outputTokens: 1_000_000 });
    expect(meter.estimatedPence).toBe(48);
    expect(meter.calls).toBe(2);
  });

  it("rounds a tiny call up to a penny, so the estimate never says 'free'", () => {
    const meter = new CostMeter({ model: "claude-haiku-5-5", capPence: 100 });
    meter.add({ inputTokens: 500, outputTokens: 50 });
    expect(meter.estimatedPence).toBe(1);
  });

  it("throws once the cap is passed, and keeps the totals", () => {
    const meter = new CostMeter({ model: "claude-sonnet-5-5", capPence: 1, gbpPerUsd: 1 });
    // $2 per million input tokens: 5,000 tokens is 1 cent, i.e. 1p at parity. Not over yet.
    meter.add({ inputTokens: 5_000, outputTokens: 0 });
    expect(meter.estimatedPence).toBe(1);
    expect(() => meter.add({ inputTokens: 5_000, outputTokens: 0 })).toThrow(CostCapExceededError);
    expect(meter.inputTokens).toBe(10_000);
  });

  it("refuses a model it has no price for", () => {
    expect(() => new CostMeter({ model: "mystery-model", capPence: 10 })).toThrow(
      /No price on file/,
    );
  });

  it("costs nothing for the fake model", () => {
    const meter = new CostMeter({ model: "fake-model", capPence: 0 });
    meter.add({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(meter.estimatedPence).toBe(0);
  });
});
