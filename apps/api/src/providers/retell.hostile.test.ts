// The Retell adapter's webhook checks at their edges: the replay window to the millisecond,
// headers in shapes Retell never sends, and genuine payloads with nulls and odd text in them.
import { describe, expect, it } from "vitest";
import { signRetellWebhook, RetellVoiceProvider } from "./retell.ts";
import { WebhookVerificationError } from "./voice.ts";

const KEY = "not-a-real-key";
const NOW = new Date("2026-11-11T12:00:00Z");
const provider = () => new RetellVoiceProvider({ apiKey: KEY, now: () => NOW });

const CALL = {
  call_type: "phone_call",
  call_id: "call_hostile_1",
  agent_id: "agent_hostile_1",
  from_number: "+447700900123",
  to_number: "+441164960001",
  start_timestamp: NOW.getTime() - 120_000,
  end_timestamp: NOW.getTime() - 30_000,
  duration_ms: 90_000,
  disconnection_reason: "user_hangup",
  transcript_object: [
    { role: "agent", content: "Hi, you're through to Hostile Heating." },
    { role: "user", content: "Hello." },
  ],
};

function signed(body: unknown, at = NOW.getTime(), key = KEY) {
  const rawBody = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  return { rawBody, header: signRetellWebhook(rawBody, key, at) };
}

describe("Retell's replay window", () => {
  it.each([
    ["exactly five minutes old", -300_000, true],
    ["five minutes and a millisecond old", -300_001, false],
    ["exactly five minutes ahead", 300_000, true],
    ["five minutes and a millisecond ahead", 300_001, false],
  ])("treats a signature %s as %s", (_what, offset, accepted) => {
    const { rawBody, header } = signed({ event: "call_ended", call: CALL }, NOW.getTime() + offset);
    const verify = () =>
      provider().verifyAndParseWebhook(rawBody, { "x-retell-signature": header });
    if (accepted) expect(verify()).toMatchObject({ type: "call_ended" });
    else expect(verify).toThrow("Stale webhook signature");
  });

  it("refuses a timestamp too long to be a number", () => {
    const { rawBody, header } = signed({ event: "call_ended", call: CALL });
    const digest = header.split(",d=")[1]!;
    expect(() =>
      provider().verifyAndParseWebhook(rawBody, {
        "x-retell-signature": `v=${"9".repeat(400)},d=${digest}`,
      }),
    ).toThrow(WebhookVerificationError);
  });
});

describe("Retell signature headers in shapes it never sends", () => {
  const { rawBody, header } = signed({ event: "call_ended", call: CALL });

  it.each([
    ["sent twice", [header, header]],
    ["in upper case", header.toUpperCase()],
    ["with spaces", header.replace(",", ", ")],
    ["with the digest cut short", header.slice(0, -2)],
    ["with an extra field", `${header},x=1`],
  ])("refuses the header %s", (_what, value) => {
    expect(() =>
      provider().verifyAndParseWebhook(rawBody, { "x-retell-signature": value }),
    ).toThrow(WebhookVerificationError);
  });

  it.each([
    ["a trailing newline", Buffer.concat([rawBody, Buffer.from("\n")])],
    ["one byte changed", Buffer.from(rawBody.toString("utf8").replace("Hello.", "Hello!"))],
    ["nothing", Buffer.alloc(0)],
  ])("refuses the signed body with %s", (_what, body) => {
    expect(() => provider().verifyAndParseWebhook(body, { "x-retell-signature": header })).toThrow(
      "Invalid webhook signature",
    );
  });

  it("refuses a body signed for the function route on its own terms too: a malformed call", () => {
    const fn = signed({ name: "gas_emergency_alert" });
    expect(() =>
      provider().verifyAndParseFunctionCall(fn.rawBody, { "x-retell-signature": fn.header }),
    ).toThrow("Malformed Retell function call body");
    const blank = signed({ name: "", call: { call_id: "c", agent_id: "a" } });
    expect(() =>
      provider().verifyAndParseFunctionCall(blank.rawBody, { "x-retell-signature": blank.header }),
    ).toThrow("Malformed Retell function call body");
  });
});

describe("genuine Retell payloads with odd contents", () => {
  const parse = (call: Record<string, unknown>) => {
    const { rawBody, header } = signed({ event: "call_ended", call: { ...CALL, ...call } });
    return provider().verifyAndParseWebhook(rawBody, { "x-retell-signature": header });
  };

  it("keeps any script, emoji and markup in the transcript exactly", () => {
    const text = 'Ma chaudière fuit \u{1F525} 漏水 <script>alert(1)</script> & "q"';
    expect(parse({ transcript_object: [{ role: "user", content: text }] })).toMatchObject({
      transcript: [{ role: "caller", text }],
    });
  });

  it("takes a null transcript as an empty one, and a missing end as the start", () => {
    expect(
      parse({ transcript_object: null, end_timestamp: null, duration_ms: null }),
    ).toMatchObject({
      transcript: [],
      endedAt: new Date(CALL.start_timestamp),
      durationSeconds: 0,
    });
  });

  it.each(["+266696687", "anonymous", "", "07700900123", "+44 7700 900123"])(
    "reads a caller ID of %j as withheld",
    (from_number) => {
      expect(parse({ from_number })).toMatchObject({ callerNumber: null });
    },
  );

  it("drops tool calls and node changes from the transcript, whatever role names they use", () => {
    expect(
      parse({
        transcript_object: [
          { role: "tool_call_invocation", content: "gas_emergency_alert" },
          { role: "node_transition", content: null },
          { role: "AGENT", content: "upper-case role" },
          { role: "user", content: "Help." },
        ],
      }),
    ).toMatchObject({ transcript: [{ role: "caller", text: "Help." }] });
  });

  it("maps the function call's withheld caller and web call to nulls", () => {
    const { rawBody, header } = signed({
      name: "danger_alert",
      call: { call_id: "call_1", agent_id: "agent_1", from_number: "+266696687", to_number: null },
      args: { anything: ["at", "all"] },
    });
    expect(
      provider().verifyAndParseFunctionCall(rawBody, { "x-retell-signature": header }),
    ).toEqual({
      type: "function_call",
      name: "danger_alert",
      providerCallId: "call_1",
      providerAgentId: "agent_1",
      dialledNumber: null,
      callerNumber: null,
    });
  });
});
