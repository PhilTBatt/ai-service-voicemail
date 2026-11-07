// The cost cap for an eval run (BUILD_PLAN Step 7). Every model call adds its token usage;
// once the estimate passes the cap, the run aborts. An estimate, not a bill: pence are
// rounded up and the exchange rate is a setting, so the cap errs on the side of stopping.
import type { LlmUsage } from "../providers/llm.ts";

// One price list for the whole app: core/prices.ts.
import { MODEL_PRICES_USD_PER_MTOK } from "../core/prices.ts";

export { MODEL_PRICES_USD_PER_MTOK };

export class CostCapExceededError extends Error {
  override readonly name = "CostCapExceededError";
  readonly estimatedPence: number;
  readonly capPence: number;

  constructor(estimatedPence: number, capPence: number) {
    super(`Eval run stopped: estimated cost ${estimatedPence}p passed the cap of ${capPence}p`);
    this.estimatedPence = estimatedPence;
    this.capPence = capPence;
  }
}

export interface CostMeterOptions {
  model: string;
  capPence: number;
  /** Pounds per dollar. A setting, because the rate moves; 0.8 is a deliberately high guess. */
  gbpPerUsd?: number;
}

export class CostMeter {
  readonly model: string;
  readonly capPence: number;
  private readonly gbpPerUsd: number;
  private readonly prices: { input: number; output: number };
  inputTokens = 0;
  outputTokens = 0;
  calls = 0;

  constructor({ model, capPence, gbpPerUsd = 0.8 }: CostMeterOptions) {
    const prices = MODEL_PRICES_USD_PER_MTOK[model];
    if (!prices)
      throw new Error(`No price on file for model ${model}; add it to MODEL_PRICES_USD_PER_MTOK`);
    this.model = model;
    this.capPence = capPence;
    this.gbpPerUsd = gbpPerUsd;
    this.prices = prices;
  }

  /** Records a call's usage and throws once the cap is passed. */
  add(usage: LlmUsage): void {
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    this.calls += 1;
    if (this.estimatedPence > this.capPence) {
      throw new CostCapExceededError(this.estimatedPence, this.capPence);
    }
  }

  /** Whole pence, rounded up. */
  get estimatedPence(): number {
    const usd =
      (this.inputTokens * this.prices.input + this.outputTokens * this.prices.output) / 1_000_000;
    const pence = usd * this.gbpPerUsd * 100;
    return Math.ceil(Number(pence.toFixed(6))); // drop float noise before rounding up
  }
}
