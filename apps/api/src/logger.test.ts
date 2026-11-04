import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import winston from "winston";
import { createLogger } from "./logger.ts";

// Captures each log line as parsed JSON, exactly as it would be written to stdout.
function captureLogger() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      done();
    },
  });
  return { logger: createLogger(new winston.transports.Stream({ stream })), lines };
}

describe("logger", () => {
  it("writes one JSON line with level, message and timestamp", () => {
    const { logger, lines } = captureLogger();
    logger.info("Call received", { callId: "call_123" });
    expect(lines).toEqual([
      {
        level: "info",
        message: "Call received",
        callId: "call_123",
        timestamp: expect.any(String) as unknown,
      },
    ]);
  });

  it("redacts the message text and metadata before writing", () => {
    const { logger, lines } = captureLogger();
    logger.warn("SMS to 07700 900123 failed", {
      to: "+447700900123",
      transcript: "My boiler's broken, I'm at XQ12 3JL",
      sms: { body: "New enquiry" },
    });
    expect(lines[0]).toMatchObject({
      message: "SMS to [phone] failed",
      to: "[phone]",
      transcript: "[redacted]",
      sms: { body: "[redacted]" },
    });
  });

  it("logs an Error in metadata with its message and stack", () => {
    const { logger, lines } = captureLogger();
    logger.error("Send failed", { error: new Error("Rejected 07700 900123") });
    expect(lines[0]?.error).toMatchObject({ name: "Error", message: "Rejected [phone]" });
    expect(JSON.stringify(lines[0])).not.toContain("900123");
  });

  it("drops lines below the configured level", () => {
    const { logger, lines } = captureLogger();
    logger.level = "warn";
    logger.info("not written");
    logger.warn("written");
    expect(lines.map((line) => line.message)).toEqual(["written"]);
  });
});
