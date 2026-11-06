// The Anthropic adapter. Structured output: the API is told the JSON schema and the SDK
// parses the reply against the zod schema, so the pipeline never sees free text.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
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
      ...(customFetch && { fetch: customFetch }),
    });
  }

  async extract<T>({ system, user, schema }: LlmRequest<T>): Promise<LlmResult<T>> {
    // The schema is sent as the output format, so the API constrains the reply to it. The
    // reply is still validated here (rather than with the SDK's parse(), which throws
    // before returning usage), so tokens are counted whatever comes back.
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024, // a few hundred tokens of JSON; the cap guards runaway output
      system,
      messages: [{ role: "user", content: user }],
      output_config: { format: zodOutputFormat(schema) },
    });
    const usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
    if (response.stop_reason === "refusal") return { ok: false, reason: "refused", usage };

    const text = response.content.find((block) => block.type === "text")?.text;
    let json: unknown;
    try {
      json = JSON.parse(text ?? "");
    } catch {
      return { ok: false, reason: "invalid-output", usage };
    }
    const parsed = schema.safeParse(json);
    return parsed.success
      ? { ok: true, value: parsed.data, usage }
      : { ok: false, reason: "invalid-output", usage };
  }
}
