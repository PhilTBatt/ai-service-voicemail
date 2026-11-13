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
  const logger = winston.createLogger({
    level: "info",
    format: winston.format.combine(
      winston.format.errors({ stack: true }),
      redactFormat(),
      winston.format.timestamp(),
      winston.format.json(),
    ),
    transports: [transport],
  });
  // Given a field called "message" (logger.info("Sent", { message })), Winston appends it to the
  // line's own text before any format runs (winston 3.19, Logger.prototype.log), where it would
  // only be pattern-redacted: a transcript or a text's body logged that way would keep its
  // words. Every level method (logger.info and the rest) goes through log, so here, first, such
  // a field is replaced whole, as redactFormat does to every other content field. An Error's own
  // message isn't a field: it stays, pattern-redacted, as errors always have.
  const log = logger.log.bind(logger);
  logger.log = ((...args: unknown[]) =>
    args.length > 2
      ? (log as (...all: unknown[]) => winston.Logger)(
          args[0],
          args[1],
          ...args.slice(2).map(withoutMessageField),
        )
      : (log as (...all: unknown[]) => winston.Logger)(...args)) as typeof logger.log;
  return logger;
}

/** A log call's details with any field called "message" replaced whole. Errors pass as they are. */
function withoutMessageField(meta: unknown): unknown {
  if (typeof meta !== "object" || meta === null || meta instanceof Error) return meta;
  if (!Object.hasOwn(meta, "message")) return meta;
  return { ...meta, message: redactField("message", (meta as { message: unknown }).message) };
}

export const logger = createLogger();
