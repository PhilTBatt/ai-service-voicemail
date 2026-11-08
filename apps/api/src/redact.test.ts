import { describe, expect, it } from "vitest";
import { signCallLink } from "./core/signed-links.ts";
import { redactField, redactText, redactValue } from "./redact.ts";

// Fictional data only. Phone numbers come from Ofcom's ranges reserved for drama:
// https://www.ofcom.org.uk/phones-and-broadband/phone-numbers/numbers-for-drama
// Postcodes use area letters that don't exist (Q and X are never used as a first letter).
// Emails use domains reserved for examples (RFC 2606).

const PHONES = [
  // Mobile: 07700 900000 to 900999
  "07700 900123",
  "07700900123",
  "07700 900 123",
  "07700-900-123",
  "+44 7700 900123",
  "+447700900123",
  "+44 (0)7700 900123",
  "0044 7700 900123",
  // London 020 7946 0xxx, with and without brackets
  "020 7946 0123",
  "02079460123",
  "(020) 7946 0123",
  "+44 20 7946 0123",
  // Other geographic: 4-digit area code, 5-digit area code, Northern Ireland, Cardiff
  "0113 496 0123",
  "0161 496 0999",
  "0191 498 0123",
  "01632 960123",
  "028 9649 6123",
  "029 2018 0123",
  // Freephone and UK-wide
  "08081 570123",
  "03069 990123",
  // A caller from abroad (US 555-01xx is reserved for fiction)
  "+1 202-555-0143",
  "001 202 555 0143",
  // Shapes the patterns used to miss
  "07700.900.123", // dots
  "%2B447700900123", // percent-encoded, as in a form body or URL
  "447700900123", // the 44 without its +
  "7700900123", // a mobile without its 0
];

const POSTCODES = [
  "X1 1AB", // A9 9AA
  "X12 3CD", // A99 9AA
  "X1A 2EF", // A9A 9AA
  "XQ1 2GH", // AA9 9AA
  "XQ12 3JL", // AA99 9AA
  "XQ1A 2NP", // AA9A 9AA
  "xq12 3jl", // lower case
  "XQ123JL", // no space
  "XQ12  3JL", // two spaces
  "XQ12+3JL", // form-encoded space
  "XQ12%203JL", // percent-encoded space
];

const EMAILS = [
  "caller@example.com",
  "first.last+tag@sub.example.org",
  "07700900123@example.net",
  "zoë@example.com", // letters beyond ASCII
  "jo@exämple.org",
  "jo%40example.com", // percent-encoded @
  "jo@exam", // cut off part-way, as in a truncated message
];

// Things that look number-ish but aren't personal data, so must survive.
const HARMLESS = [
  "2026-11-04T16:49:27.000Z",
  "3f2b8c1e-4d5a-4b6c-9e7f-1a2b3c4d5e6f",
  "CA0123456789abcdef0123456789abcdef",
  "listening on port 3000",
  "billable seconds: 125",
  "£120.50",
];

describe("redactText", () => {
  it.each(PHONES)("masks the phone number %s", (phone) => {
    expect(redactText(`Call back on ${phone} today`)).toBe("Call back on [phone] today");
  });

  it.each(POSTCODES)("masks the postcode %s", (postcode) => {
    expect(redactText(`Lives at ${postcode}, near the park`)).toBe(
      "Lives at [postcode], near the park",
    );
  });

  it.each(EMAILS)("masks the email %s", (email) => {
    expect(redactText(`Email ${email} please`)).toBe("Email [email] please");
  });

  it.each(HARMLESS)("leaves %s alone", (text) => {
    expect(redactText(text)).toBe(text);
  });

  it("masks several kinds of data in one string", () => {
    expect(redactText("Jo on 07700 900123, jo@example.com, XQ12 3JL")).toBe(
      "Jo on [phone], [email], [postcode]",
    );
  });

  it("stays fast on a long hostile string (no runaway regex)", () => {
    const start = performance.now();
    redactText("a.".repeat(50_000));
    expect(performance.now() - start).toBeLessThan(1_000);
  });
});

describe("redactField", () => {
  it.each([
    "transcript",
    "summary",
    "body",
    "message",
    "Body",
    "TRANSCRIPT",
    "text",
    "content",
    "callerName",
    "extracted_fields",
  ])("replaces the %s field whole, whatever its case", (key) => {
    expect(redactField(key, "I'm at home, my boiler is broken")).toBe("[redacted]");
  });

  it("pattern-redacts any other field", () => {
    expect(redactField("callerNumber", "+447700900123")).toBe("[phone]");
  });
});

describe("redactValue", () => {
  it("redacts nested objects and arrays", () => {
    expect(
      redactValue({
        call: { from: "07700 900123", body: "secret text" },
        notes: ["XQ12 3JL", { summary: "secret text" }],
      }),
    ).toEqual({
      call: { from: "[phone]", body: "[redacted]" },
      notes: ["[postcode]", { summary: "[redacted]" }],
    });
  });

  it("doesn't modify the original object", () => {
    const original = { from: "07700 900123", nested: { transcript: "secret text" } };
    redactValue(original);
    expect(original).toEqual({ from: "07700 900123", nested: { transcript: "secret text" } });
  });

  it("keeps numbers, booleans, null and dates as they are", () => {
    const at = new Date("2026-11-04T12:00:00Z");
    expect(redactValue({ n: 42, ok: true, none: null, at })).toEqual({
      n: 42,
      ok: true,
      none: null,
      at,
    });
  });

  it("keeps an Error's name, message and stack, pattern-redacted", () => {
    const error = new Error("SMS to 07700 900123 failed", { cause: new Error("timeout") });
    const result = redactValue(error) as Record<string, unknown>;
    expect(result.name).toBe("Error");
    expect(result.message).toBe("SMS to [phone] failed");
    expect(result.stack).toContain("SMS to [phone] failed");
    expect(result.stack).not.toContain("900123");
    expect(result.cause).toMatchObject({ message: "timeout" });
  });

  it("keeps an Error's plain fields but drops attached objects like connections and requests", () => {
    const error = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
      port: 5434,
      client: { user: "callmate", secretKey: 123 },
      config: { headers: { Authorization: "Basic abc123" } },
    });
    const result = redactValue(error) as Record<string, unknown>;
    expect(result).toMatchObject({ code: "ECONNREFUSED", port: 5434 });
    expect(result).not.toHaveProperty("client");
    expect(result).not.toHaveProperty("config");
  });

  it("replaces binary data with its size", () => {
    expect(redactValue(Buffer.from("audio bytes"))).toBe("[binary: 11 bytes]");
  });

  it("handles circular references without crashing", () => {
    const loop: Record<string, unknown> = { name: "loop" };
    loop.self = loop;
    expect(redactValue(loop)).toEqual({ name: "loop", self: "[circular]" });
  });

  it("allows the same object twice when it isn't circular", () => {
    const shared = { from: "07700 900123" };
    expect(redactValue({ a: shared, b: shared })).toEqual({
      a: { from: "[phone]" },
      b: { from: "[phone]" },
    });
  });
});

describe("call-page tokens", () => {
  it("masks a signed call link wherever it appears, since the token is a credential", () => {
    const token = signCallLink(
      {
        callId: "0b6f2b3c-9d1e-4a7f-8c2d-1e3f4a5b6c7d",
        expiresAt: new Date("2026-12-01T00:00:00Z"),
      },
      "test-signing-secret-at-least-32-characters-long",
    );
    expect(redactText(`GET /c/${token} 500`)).toBe("GET /c/[token] 500");
    expect(redactText(`https://callmate.example.com/c/${token}/recording`)).toBe(
      "https://callmate.example.com/c/[token]/recording",
    );
    expect(redactValue({ path: `/c/${token}` })).toEqual({ path: "/c/[token]" });
  });
});

describe("provider errors", () => {
  it("never carry the address or number the provider quoted", async () => {
    const { PostmarkApiError } = await import("./providers/postmark.ts");
    const { TwilioApiError } = await import("./providers/twilio.ts");
    const { RetellApiError } = await import("./providers/retell.ts");
    const bounced = new PostmarkApiError(
      422,
      406,
      "You tried to send to recipient(s) that have been marked as inactive. Found inactive addresses: jo@example.com.",
    );
    expect(bounced.message).not.toContain("jo@example.com");
    expect(bounced.message).toContain("[email]");
    const refused = new TwilioApiError(
      400,
      "/Calls.json?To=%2B441134960150",
      "The 'To' number +447700900123 is not a valid phone number.",
    );
    expect(refused.message).not.toMatch(/447700900123|441134960150/);
    const retell = new RetellApiError(
      400,
      "/register-phone-call",
      "from_number +447700900123 invalid",
    );
    expect(retell.message).not.toContain("447700900123");
  });
});
