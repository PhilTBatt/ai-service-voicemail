// The seam between CallMate and the LLM. The pipeline hands over a prompt and a zod schema
// and gets back a validated value, or a reason it couldn't.
import type { z } from "zod";

export interface LlmRequest<T> {
  system: string;
  user: string;
  schema: z.ZodType<T>;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export type LlmResult<T> =
  | { ok: true; value: T; usage: LlmUsage }
  /** The model answered, but not with something the schema accepts. Worth one retry. */
  | { ok: false; reason: "invalid-output"; usage: LlmUsage }
  /** The model declined. Retrying won't help. */
  | { ok: false; reason: "refused"; usage: LlmUsage };

export interface LlmProvider {
  /** The model in use, for cost rows and logs. */
  readonly model: string;
  /** Rejects on transport or API errors (rate limits, outages), which the job queue retries. */
  extract<T>(request: LlmRequest<T>): Promise<LlmResult<T>>;
}
