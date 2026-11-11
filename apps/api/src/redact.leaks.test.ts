// What the logs must never hold (CLAUDE.md): transcripts, summaries, phone numbers, emails and
// postcodes. redact.test.ts checks each pattern on its own; this file pushes the whole logger
// with the shapes that personal data actually arrives in: form-encoded webhook bodies, URLs,
// database errors, nested provider payloads, errors with causes, and the content keys under
// every name our code and Retell give them. A line is checked as written, after JSON, so a
// value the redactor missed anywhere in it fails the test.
//
// Fictional data only: Ofcom drama numbers, example.com addresses, postcodes with area letters
// that don't exist (X and Q are never first letters).
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import winston from "winston";
import { createLogger } from "./logger.ts";
import { redactField, redactText, redactValue } from "./redact.ts";

const MOBILE = "+447700900456";
const LANDLINE = "+441134960321";
const EMAIL = "sam.caller@example.com";
const POSTCODE = "XQ7 4LB";
const TRANSCRIPT_WORDS = "my boiler is pouring water through the ceiling";
const SUMMARY_WORDS = "Caller reports a burst pipe in the loft";

/** The digits that would identify the caller, however the number is written. */
const SECRET_FRAGMENTS = ["900456", "4960321", "sam.caller", "XQ7", "pouring water", "burst pipe"];

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  return { logger: createLogger(new winston.transports.Stream({ stream })), lines };
}

/** Fails naming the fragment that got through, so a failure says what leaked. */
function expectClean(written: string) {
  for (const fragment of SECRET_FRAGMENTS) {
    expect(written, `"${fragment}" reached the log`).not.toContain(fragment);
  }
}

describe("the logger never writes personal data, whatever shape it arrives in", () => {
  it("masks numbers in a form-encoded webhook body, where + stands for a space", () => {
    // How Twilio posts an SMS: the + of the number is %2B, and each space a typed number
    // had is a +. The second form used to pass straight through.
    const { logger, lines } = capture();
    logger.warn("Refused a Twilio body", {
      raw: `From=%2B447700900456&To=%2B441134960321&Body=Ring+me+on+07700+900456+or+0113+496+0321`,
    });
    expectClean(lines.join(""));
  });

  it("masks a number joined to a word by an underscore, as in a key or a file name", () => {
    expect(redactText("caller_07700900456")).toBe("caller_[phone]");
    expect(redactText("voicemail_447700900456.wav")).toBe("voicemail_[phone].wav");
  });

  it("masks every way of writing the same mobile and landline", () => {
    const shapes = [
      MOBILE,
      "07700 900456",
      "07700-900-456",
      "07700.900.456",
      "(07700) 900456",
      "+44 (0)7700 900456",
      "+44 (0) 7700 900456",
      "0044 7700 900456",
      "447700900456",
      "7700900456",
      "%2B447700900456",
      "%2b447700900456",
      "07700%20900456",
      "07700+900456",
      "+44+7700+900456",
      "07700 900456", // a non-breaking space, as a phone keyboard or a PDF gives
      "tel:+447700900456",
      LANDLINE,
      "0113 496 0321",
      "(0113) 496 0321",
      "0113+496+0321",
    ];
    for (const shape of shapes) {
      const out = redactText(`ring ${shape} now`);
      expect(out, shape).toContain("[phone]");
      expect(out, shape).not.toMatch(/900456|4960321|496 0321|900 456/);
    }
  });

  it("masks emails and postcodes inside URLs and query strings", () => {
    const url = `https://callmate.example.com/api/x?email=sam.caller%40example.com&to=%2B447700900456&pc=XQ7%204LB`;
    expectClean(redactText(url));
    expectClean(redactText(`mailto:${EMAIL}?subject=Job at ${POSTCODE}`));
  });

  it("masks a number inside a JSON string that was logged as text", () => {
    const text = JSON.stringify({
      from: MOBILE,
      email: EMAIL,
      address: `1 Imaginary Row, ${POSTCODE}`,
    });
    expectClean(redactText(text));
    // And JSON inside JSON, as a provider's error body quoting our request does.
    expectClean(redactText(JSON.stringify({ body: text })));
  });

  it("masks what a Postgres error quotes back (a unique violation names the value)", () => {
    const { logger, lines } = capture();
    const error = Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
      detail: `Key (number)=(${MOBILE}) already exists.`,
      constraint: "phone_numbers_one_active_per_number",
    });
    logger.error("Insert failed", { error });
    const written = lines.join("");
    expectClean(written);
    // The parts that make it debuggable stay.
    expect(written).toContain("23505");
    expect(written).toContain("phone_numbers_one_active_per_number");
  });

  it("masks data in an error's cause chain, and in the stack, to any depth", () => {
    const { logger, lines } = capture();
    const root = new Error(`Twilio refused ${MOBILE}`);
    const middle = new Error(`email to ${EMAIL} failed`, { cause: root });
    const top = new Error(`notification for ${POSTCODE} failed`, { cause: middle });
    logger.error("Job failed", { error: top });
    logger.error(top);
    expectClean(lines.join(""));
    expect(lines).toHaveLength(2);
  });

  it("replaces call content whole, under every name it goes by", () => {
    // Snake case from Retell, camel case from our own code: the value is content either way,
    // and a summary has no pattern to catch it by.
    const keys = [
      "transcript",
      "transcript_object",
      "transcriptObject",
      "transcript_with_tool_calls",
      "summary",
      "call_summary",
      "callSummary",
      "extracted_fields",
      "extractedFields",
      "callerName",
      "caller_name",
      "custom_analysis_data",
      "body",
      "text",
      "content",
    ];
    for (const key of keys) {
      expect(redactField(key, `${SUMMARY_WORDS}. ${TRANSCRIPT_WORDS}`), key).toBe("[redacted]");
      expect(redactField(key, [{ role: "user", words: [{ word: "pouring water" }] }]), key).toBe(
        "[redacted]",
      );
    }
  });

  it("masks a whole Retell call_ended payload, nested as Retell sends it", () => {
    const { logger, lines } = capture();
    logger.info("Webhook received", {
      event: "call_ended",
      call: {
        call_id: "call_fake_0001",
        from_number: MOBILE,
        to_number: LANDLINE,
        transcript: `Agent: Hello. User: ${TRANSCRIPT_WORDS}`,
        transcript_object: [{ role: "user", content: TRANSCRIPT_WORDS, words: [] }],
        transcript_with_tool_calls: [
          { role: "user", content: TRANSCRIPT_WORDS, words: [{ word: "pouring water" }] },
        ],
        call_analysis: {
          call_summary: SUMMARY_WORDS,
          custom_analysis_data: { postcode: POSTCODE, callback: "07700 900456" },
        },
        metadata: { notes: `email ${EMAIL}` },
      },
    });
    const written = lines.join("");
    expectClean(written);
    // The identifiers needed to trace it stay.
    expect(written).toContain("call_fake_0001");
  });

  it("masks the log line's own message, and data put straight into it with a template", () => {
    const { logger, lines } = capture();
    logger.warn(`SMS to ${MOBILE} for ${EMAIL} at ${POSTCODE} failed`);
    expectClean(lines.join(""));
  });

  it("masks data in arrays of arrays and in objects many levels down", () => {
    let deep: unknown = { to: MOBILE };
    for (let i = 0; i < 50; i++) deep = { level: i, next: deep, list: [[EMAIL], [POSTCODE]] };
    const { logger, lines } = capture();
    logger.info("Deep", { deep });
    expectClean(lines.join(""));
  });

  it("never changes what the caller passed in", () => {
    const meta = { to: MOBILE, nested: { transcript: TRANSCRIPT_WORDS } };
    const before = JSON.stringify(meta);
    redactValue(meta);
    const { logger } = capture();
    logger.info("x", meta);
    expect(JSON.stringify(meta)).toBe(before);
  });

  it("leaves identifiers the logs need alone: UUIDs, provider SIDs, ISO times, amounts", () => {
    for (const harmless of [
      "6f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b",
      "SM0123456789abcdef0123456789abcdef",
      "RE0123456789abcdef0123456789abcdef",
      "CAfedcba98765432100123456789abcdef",
      "2026-03-29T01:00:00.000Z",
      "9900 pence",
      "statement_timeout=10000",
    ]) {
      expect(redactText(harmless), harmless).toBe(harmless);
    }
  });

  it("stays fast on long hostile input with many near-miss numbers and addresses", () => {
    const hostile = [
      "0".repeat(20_000),
      "+4".repeat(20_000),
      "a@".repeat(20_000),
      "07700 ".repeat(10_000),
      "XQ1 ".repeat(10_000),
      "%2B".repeat(10_000),
    ];
    for (const text of hostile) {
      const start = performance.now();
      redactText(text);
      expect(performance.now() - start, text.slice(0, 10)).toBeLessThan(1_000);
    }
  });
});
