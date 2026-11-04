import winston from "winston";
import { redactField, redactValue } from "./redact.ts";

const redactFormat = winston.format((info) => {
  for (const key of Object.keys(info)) {
    // The log line's own text is pattern-redacted only; replacing it whole would leave
    // every line reading "[redacted]". Every other field gets the full treatment.
    info[key] = key === "message" ? redactValue(info[key]) : redactField(key, info[key]);
  }
  return info;
});

/**
 * JSON lines on stdout, redacted. The level starts at "info"; server.ts sets it from config.
 * Tests pass their own transport to capture output.
 */
export function createLogger(transport: winston.transport = new winston.transports.Console()) {
  return winston.createLogger({
    level: "info",
    format: winston.format.combine(
      winston.format.errors({ stack: true }),
      redactFormat(),
      winston.format.timestamp(),
      winston.format.json(),
    ),
    transports: [transport],
  });
}

export const logger = createLogger();
