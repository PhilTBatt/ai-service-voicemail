import { describe, expect, it } from "vitest";
import { buildExtractionPrompt, callExtractionSchema } from "../core/extraction.ts";
import { AnthropicLlmProvider } from "./anthropic.ts";

const PROMPT = buildExtractionPrompt(
  [
    { role: "agent", text: "Hi, how can I help?" },
    { role: "caller", text: "Tap's dripping. Sam, 07700 900123, XQ12 3JL." },
  ],
  { businessName: "Test Plumbing", tradespersonName: "Ant" },
);

/** A fetch that answers like the Messages API, recording the request body. */
function fakeApi(reply: { text?: string; stop_reason?: string }) {
  const requests: Record<string, unknown>[] = [];
  const fetchStub: typeof fetch = (input, init) => {
    requests.push(
      JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>,
    );
    void input;
    return Promise.resolve(
      Response.json({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-haiku-5-5",
        content: reply.text === undefined ? [] : [{ type: "text", text: reply.text }],
        stop_reason: reply.stop_reason ?? "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 321, output_tokens: 45 },
      }),
    );
  };
  return { fetch: fetchStub, requests };
}

const provider = (api: ReturnType<typeof fakeApi>) =>
  new AnthropicLlmProvider({
    apiKey: "not-a-real-key",
    model: "claude-haiku-5-5",
    fetch: api.fetch,
  });

describe("AnthropicLlmProvider", () => {
  it("asks for structured output against the schema and returns the parsed value with usage", async () => {
    const api = fakeApi({
      text: JSON.stringify({
        callerName: "Sam",
        callbackNumber: "+447700900123",
        postcode: "XQ12 3JL",
        jobSummary: "Dripping tap.",
        urgency: "routine",
        priceAsked: false,
        flags: [],
      }),
    });
    const result = await provider(api).extract({ ...PROMPT, schema: callExtractionSchema });
    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({ callerName: "Sam", urgency: "routine" }) as unknown,
      usage: { inputTokens: 321, outputTokens: 45 },
    });
    expect(api.requests[0]).toMatchObject({
      model: "claude-haiku-5-5",
      system: PROMPT.system,
      messages: [{ role: "user", content: PROMPT.user }],
      output_config: { format: { type: "json_schema" } },
    });
  });

  it("reports output that doesn't match the schema, without throwing", async () => {
    const api = fakeApi({ text: JSON.stringify({ urgency: "panic" }) });
    const result = await provider(api).extract({ ...PROMPT, schema: callExtractionSchema });
    expect(result).toMatchObject({ ok: false, reason: "invalid-output" });
  });

  it("reports a refusal", async () => {
    const api = fakeApi({ stop_reason: "refusal" });
    const result = await provider(api).extract({ ...PROMPT, schema: callExtractionSchema });
    expect(result).toMatchObject({ ok: false, reason: "refused" });
  });
});

// Against the real API. Costs a fraction of a penny. Needs ANTHROPIC_LIVE_TESTS=1 and ANTHROPIC_API_KEY.
//   PowerShell: $env:ANTHROPIC_LIVE_TESTS = "1"; npx vitest run apps/api/src/providers/anthropic.test.ts
describe.runIf(process.env.ANTHROPIC_LIVE_TESTS === "1" && process.env.ANTHROPIC_API_KEY)(
  "live Anthropic",
  () => {
    it("extracts the fictional caller's details", async () => {
      const live = new AnthropicLlmProvider({
        apiKey: process.env.ANTHROPIC_API_KEY!,
        model: "claude-haiku-5-5",
      });
      const result = await live.extract({ ...PROMPT, schema: callExtractionSchema });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.callbackNumber).toBe("+447700900123");
      expect(result.value.postcode).toBe("XQ12 3JL");
      expect(result.value.urgency).toBe("routine");
    }, 30_000);
  },
);

describe("AnthropicLlmProvider limits", () => {
  it("sends a generous output cap with low effort, and reports a cut-off reply as invalid output", async () => {
    const api = fakeApi({ stop_reason: "max_tokens" });
    const result = await provider(api).extract({ ...PROMPT, schema: callExtractionSchema });
    expect(result).toEqual({
      ok: false,
      reason: "invalid-output",
      usage: { inputTokens: 321, outputTokens: 45 },
    });
    expect(api.requests[0]).toMatchObject({
      max_tokens: 4096,
      output_config: { effort: "low" },
    });
  });
});
