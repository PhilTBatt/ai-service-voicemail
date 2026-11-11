// The Anthropic adapter. Structured output: the API is told the JSON schema and the SDK
// parses the reply against the zod schema, so the pipeline never sees free text.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { logger } from "../logger.ts";
import type { LlmProvider, LlmRequest, LlmResult } from "./llm.ts";

export interface AnthropicOptions {
  apiKey: string;
  /** Pinned in config (BUILD_PLAN Step 5): the current small model by default. */
  model: string;
  /** Injected by tests. */
  fetch?: typeof fetch;
}

export class AnthropicLlmProvider implements LlmProvider {
  readonly model: string;
  private readonly client: Anthropic;

  constructor({ apiKey, model, fetch: customFetch }: AnthropicOptions) {
    this.model = model;
    this.client = new Anthropic({
      apiKey,
      // Extraction is short and the queue retries whole jobs, so fail fast here.
      timeout: 30_000,
      maxRetries: 1,
      // Fixed, so ANTHROPIC_LOG=debug can't make the SDK print requests to the console: their
      // bodies are transcripts, past our redacting logger.
      logLevel: "warn",
      ...(customFetch && { fetch: customFetch }),
    });
  }

  async extract<T>({ system, user, schema }: LlmRequest<T>): Promise<LlmResult<T>> {
    // The schema is sent as the output format, so the API constrains the reply to it. The
    // reply is still validated here (rather than with the SDK's parse(), which throws
    // before returning usage), so tokens are counted whatever comes back.
    const response = await this.client.messages.create({
      model: this.model,
      // The answer is a few hundred tokens of JSON, but the model's own thinking counts
      // against this cap too, so it's generous; `effort: "low"` keeps that thinking short for
      // what is a simple extraction.
      max_tokens: 4096,
      system,
      messages: [{ role: "user", content: user }],
      output_config: { format: zodOutputFormat(schema), effort: "low" },
    });
    const usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
    if (response.stop_reason === "refusal") return { ok: false, reason: "refused", usage };
    if (response.stop_reason === "max_tokens") {
      // Nothing usable comes back when the cap is hit; say so, rather than failing on empty JSON.
      logger.warn("LLM output cut off at max_tokens", { model: this.model, ...usage });
      return { ok: false, reason: "invalid-output", usage };
    }

    const text = response.content.find((block) => block.type === "text")?.text;
    let json: unknown;
    try {
      json = JSON.parse(text ?? "");
    } catch {
      return { ok: false, reason: "invalid-output", usage };
    }
    const parsed = schema.safeParse(json);
    if (parsed.success) return { ok: true, value: parsed.data, usage };
    // Which field broke which rule, never what it held (a transcript's words): before this, an
    // invalid extraction left nothing to say why (the eval run of 2026-11-11).
    logger.warn("LLM output didn't match the schema", {
      model: this.model,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
      })),
    });
    return { ok: false, reason: "invalid-output", usage };
  }
}
