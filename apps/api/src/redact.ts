// Masks personal data before it reaches the logs (CLAUDE.md: never log phone numbers, emails,
// postcodes, transcripts or summaries unredacted). Over-matching is deliberate: masking a
// harmless value costs nothing, while a leaked phone number is a data breach.

// The lookbehind only lets a match start at the beginning of a run of address characters.
// Without it the pattern retries from every position, and a 100k-character string takes
// over 10 seconds, blocking the whole process.
const EMAIL = /(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

// UK numbers written nationally (07700 900123, (020) 7946 0123) or internationally
// (+44 7700 900123, +44 (0)20 7946 0123, 0044 7700 900123), with spaces or hyphens.
const UK_PHONE = /(?:(?:\+|\b00)44[\s-]?(?:\(0\)[\s-]?)?|\(?\b0)[1-9](?:[\s-]?\)?[\s-]?\d){8,9}\b/g;

// Any other international number (+ then 8 to 15 digits), such as a caller from abroad.
const INTERNATIONAL_PHONE = /\+[1-9](?:[\s-]?\d){7,14}\b/g;

// UK postcodes in all six shapes (A9 9AA to AA9A 9AA), any case, with or without the space.
const POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/gi;

const REDACTED_KEYS = new Set(["transcript", "summary", "body", "message"]);

export function redactText(text: string): string {
  return text
    .replace(EMAIL, "[email]")
    .replace(UK_PHONE, "[phone]")
    .replace(INTERNATIONAL_PHONE, "[phone]")
    .replace(POSTCODE, "[postcode]");
}

/** Redacts one field: content fields (transcript, summary, body, message) are replaced whole. */
export function redactField(key: string, value: unknown): unknown {
  return redactEntry(key, value, new WeakSet());
}

/** Returns a redacted copy of any value. Never modifies the original. */
export function redactValue(value: unknown): unknown {
  return redact(value, new WeakSet());
}

function redactEntry(key: string, value: unknown, ancestors: WeakSet<object>): unknown {
  return REDACTED_KEYS.has(key.toLowerCase()) ? "[redacted]" : redact(value, ancestors);
}

function redact(value: unknown, ancestors: WeakSet<object>): unknown {
  if (typeof value === "string") return redactText(value);
  if (typeof value !== "object" || value === null || value instanceof Date) return value;
  if (ArrayBuffer.isView(value)) return `[binary: ${value.byteLength} bytes]`;
  if (ancestors.has(value)) return "[circular]";

  ancestors.add(value);
  let result: unknown;
  if (Array.isArray(value)) {
    result = value.map((item) => redact(item, ancestors));
  } else if (value instanceof Error) {
    // Library errors often carry big internal objects: pg attaches its whole connection, and
    // HTTP clients attach the request, auth headers included. Keep only plain values (code,
    // errno, status...). Name, message, stack and cause aren't enumerable, so JSON would
    // drop them: copy them explicitly. The message stays because it makes failures debuggable.
    const plainFields = Object.entries(value).filter(([, item]) =>
      ["string", "number", "boolean"].includes(typeof item),
    );
    result = {
      ...Object.fromEntries(
        plainFields.map(([key, item]) => [key, redactEntry(key, item, ancestors)]),
      ),
      name: value.name,
      message: redactText(value.message),
      ...(value.stack !== undefined && { stack: redactText(value.stack) }),
      ...(value.cause !== undefined && { cause: redact(value.cause, ancestors) }),
    };
  } else {
    result = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactEntry(key, item, ancestors)]),
    );
  }
  ancestors.delete(value);
  return result;
}
