import type { LlmProvider, LlmRequest, LlmResult } from "./llm.ts";

type Scripted =
  | { value: unknown }
  | { reason: "invalid-output" | "refused" }
  | { error: string; status?: number };

/**
 * An in-memory LlmProvider for tests. Answers are scripted in order; each one is still
 * validated against the request's schema, exactly as the real adapter validates the model.
 */
export class FakeLlmProvider implements LlmProvider {
  readonly model = "fake-model";
  readonly requests: { system: string; user: string }[] = [];
  private readonly answers: Scripted[] = [];

  /** Queues what the next call returns. */
  willReturn(value: unknown) {
    this.answers.push({ value });
    return this;
  }

  willFail(reason: "invalid-output" | "refused") {
    this.answers.push({ reason });
    return this;
  }

  /**
   * Simulates a transport or API error (rate limit, outage). With a status, the error carries
   * it as the SDK's do (401 for a revoked key, 529 when overloaded).
   */
  willThrow(message: string, status?: number) {
    this.answers.push({ error: message, ...(status !== undefined && { status }) });
    return this;
  }

  extract<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
    this.requests.push({ system: request.system, user: request.user });
    const next = this.answers.shift();
    const usage = { inputTokens: 100, outputTokens: 20 };
    if (!next) return Promise.reject(new Error("FakeLlmProvider: no scripted answer left"));
    if ("error" in next) {
      return Promise.reject(Object.assign(new Error(next.error), { status: next.status }));
    }
    if ("reason" in next) return Promise.resolve({ ok: false, reason: next.reason, usage });
    const parsed = request.schema.safeParse(next.value);
    return Promise.resolve(
      parsed.success
        ? { ok: true, value: parsed.data, usage }
        : { ok: false, reason: "invalid-output", usage },
    );
  }
}
