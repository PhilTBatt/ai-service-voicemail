// The voice platform's webhook routes against requests nobody signed, or signed but strange:
// none may reach the handlers, crash the route, or set off the server-error alert.
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { createPool } from "../db/pool.ts";
import { FakeVoiceProvider } from "../providers/voice.fake.ts";
import type { CallEndedEvent, FunctionCallEvent } from "../providers/voice.ts";
import { sampleCallEndedEvent } from "../testing/agent-fixture.ts";

// The route never touches the database; nothing listens on port 1, so no connection is made.
const UNUSED_DATABASE_URL = "postgres://callmate_app@127.0.0.1:1/callmate";

const running: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((stop) => stop()));
});

async function startApp(
  handlers: {
    onCallEnded?: (event: CallEndedEvent) => Promise<void>;
    onFunctionCall?: (event: FunctionCallEvent) => Promise<unknown>;
  } = {},
) {
  const fake = new FakeVoiceProvider();
  const alert = vi.fn();
  const received: CallEndedEvent[] = [];
  const functionCalls: FunctionCallEvent[] = [];
  const pool = createPool(UNUSED_DATABASE_URL);
  const server = createApp({
    pool,
    alert,
    voiceProviders: { fake },
    onCallEnded:
      handlers.onCallEnded ??
      ((event) => {
        received.push(event);
        return Promise.resolve();
      }),
    onFunctionCall:
      handlers.onFunctionCall ??
      ((event) => {
        functionCalls.push(event);
        return Promise.resolve();
      }),
  }).listen(0);
  await once(server, "listening");
  running.push(async () => {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  });
  const { port } = server.address() as AddressInfo;
  const post = (path: string, body: Buffer | string, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : new Uint8Array(body),
    });
  const signed = (rawBody: Buffer) => fake.signedRequest(rawBody).headers as Record<string, string>;
  return { fake, alert, received, functionCalls, post, signed };
}

describe("a provider name from the URL", () => {
  // These are properties every plain object has. Looked up naively, an unsigned request found
  // Object's own constructor and crashed the route with a 500 (counting towards the alert).
  it.each(["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf"])(
    "answers 404 for %j, on both routes, without raising an alert",
    async (name) => {
      const { alert, post } = await startApp();
      for (const path of [`/webhooks/voice/${name}`, `/webhooks/voice/${name}/function`]) {
        const response = await post(path, "{}", { "content-type": "application/json" });
        expect(response.status, path).toBe(404);
        expect(await response.json(), path).toEqual({ error: "Unknown provider" });
      }
      expect(alert).not.toHaveBeenCalled();
    },
  );
});

describe("bodies the route refuses", () => {
  it("refuses a body over 2 MB as a bad request, not a server error, and hands nothing on", async () => {
    const { alert, received, post, signed } = await startApp();
    const huge = Buffer.alloc(2 * 1024 * 1024 + 1, 0x20);
    const response = await post("/webhooks/voice/fake", huge, signed(huge));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Bad request" });
    expect(received).toEqual([]);
    expect(alert).not.toHaveBeenCalled();
  });

  it("takes a long but genuine call, well under the limit", async () => {
    const { fake, received, post } = await startApp();
    const event = sampleCallEndedEvent({
      transcript: Array.from({ length: 400 }, (_, i) => ({
        role: i % 2 === 0 ? ("agent" as const) : ("caller" as const),
        text: `Turn ${i}: ${"words ".repeat(60)}`,
      })),
    });
    const { rawBody, headers } = fake.webhookFor(event);
    expect(rawBody.length).toBeGreaterThan(100_000);
    expect(
      (await post("/webhooks/voice/fake", rawBody, headers as Record<string, string>)).status,
    ).toBe(204);
    expect(received).toEqual([event]);
  });

  it("refuses an empty body, signed or not", async () => {
    const { received, post } = await startApp();
    expect((await post("/webhooks/voice/fake", "")).status).toBe(401);
    expect(received).toEqual([]);
  });

  it("refuses a signature sent twice (duplicate headers), rather than picking one", async () => {
    const { fake, received, post } = await startApp();
    const { rawBody, headers } = fake.webhookFor(sampleCallEndedEvent());
    const signature = (headers as Record<string, string>)["x-fake-signature"]!;
    const twice = new Headers({ "content-type": "application/json" });
    twice.append("x-fake-signature", signature);
    twice.append("x-fake-signature", signature);
    const response = await post("/webhooks/voice/fake", rawBody, Object.fromEntries(twice));
    expect(response.status).toBe(401);
    expect(received).toEqual([]);
  });

  it.each([
    ["no content type", {}],
    ["a form content type", { "content-type": "application/x-www-form-urlencoded" }],
    ["text/plain", { "content-type": "text/plain" }],
  ])("verifies the bytes whatever the content type says (%s)", async (_what, contentType) => {
    const { fake, received, post } = await startApp();
    const event = sampleCallEndedEvent();
    const { rawBody, headers } = fake.webhookFor(event);
    const response = await post("/webhooks/voice/fake", rawBody, {
      ...contentType,
      "x-fake-signature": (headers as Record<string, string>)["x-fake-signature"]!,
    });
    expect(response.status).toBe(204);
    expect(received).toEqual([event]);
  });
});

describe("what a genuine webhook may carry", () => {
  it("hands on a transcript of any script, emoji and markup byte for byte", async () => {
    const { fake, received, post } = await startApp();
    const event = sampleCallEndedEvent({
      callerNumber: null,
      transcript: [
        { role: "caller", text: "Ma chaudière fuit \u{1F525} — 漏水 — تسرب" },
        { role: "caller", text: "<script>alert(1)</script> & \"quotes\" 'too'" },
        { role: "agent", text: "Line one\nline two\r\nline three four" },
        { role: "caller", text: "" },
      ],
    });
    const { rawBody, headers } = fake.webhookFor(event);
    expect(
      (await post("/webhooks/voice/fake", rawBody, headers as Record<string, string>)).status,
    ).toBe(204);
    expect(received).toEqual([event]);
  });

  it("hands on the same webhook each time it's redelivered: the database decides it's a duplicate", async () => {
    const { fake, received, post } = await startApp();
    const event = sampleCallEndedEvent();
    const { rawBody, headers } = fake.webhookFor(event);
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        post("/webhooks/voice/fake", rawBody, headers as Record<string, string>),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([204, 204, 204, 204, 204]);
    expect(received).toHaveLength(5);
  });
});

describe("POST /webhooks/voice/:provider/function when the handler fails", () => {
  const functionCall: FunctionCallEvent = {
    type: "function_call",
    name: "danger_alert",
    providerCallId: "call_hostile_0001",
    providerAgentId: "fake_agent_1",
    dialledNumber: "+441632960001",
    callerNumber: null,
  };

  it("answers 500 with nothing the agent could repeat to the caller", async () => {
    const { fake, post } = await startApp({
      onFunctionCall: () => Promise.reject(new Error("tenant 123 database password wrong")),
    });
    const { rawBody, headers } = fake.functionCallFor(functionCall);
    const response = await post(
      "/webhooks/voice/fake/function",
      rawBody,
      headers as Record<string, string>,
    );
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("password");
    expect(text).not.toContain("tenant 123");
  });

  it("passes a withheld caller and a web call (no dialled number) on as nulls", async () => {
    const { fake, functionCalls, post } = await startApp();
    const webCall = { ...functionCall, dialledNumber: null };
    const { rawBody, headers } = fake.functionCallFor(webCall);
    expect(
      (await post("/webhooks/voice/fake/function", rawBody, headers as Record<string, string>))
        .status,
    ).toBe(200);
    expect(functionCalls).toEqual([webCall]);
  });
});
