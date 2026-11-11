// Masks personal data before it reaches the logs (CLAUDE.md: never log phone numbers, emails,
// postcodes, transcripts or summaries unredacted). Over-matching is deliberate: masking a
// harmless value costs nothing, while a leaked phone number is a data breach.

// The lookbehind only lets a match start at the beginning of a run of address characters.
// Without it the pattern retries from every position, and a 100k-character string takes
// over 10 seconds, blocking the whole process. Letters in any alphabet (zoë@exämple.org).
const EMAIL = /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu;

// What's left of an address cut off mid-way ("jo@exam", when a message is truncated).
const EMAIL_CUT = /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?![\p{L}\p{N}.-])/gu;

// UK numbers written nationally (07700 900123, (020) 7946 0123) or internationally
// (+44 7700 900123, +44 (0)20 7946 0123, 0044 7700 900123), with spaces, hyphens or dots, or
// with a + for each space (a form-encoded body: Body=Call+me+on+07700+900123). A number may
// follow an underscore (caller_07700900123), which \b alone would treat as part of a word.
const UK_PHONE =
  /(?:(?:\+|(?<![A-Za-z0-9])00)44[\s.+-]?(?:\(0\)[\s.+-]?)?|\(?(?<![A-Za-z0-9])0)[1-9](?:[\s.+-]?\)?[\s.+-]?\d){8,9}\b/g;

// A UK number with its 44 but no + (447700900123), or a mobile with no leading 0 (7700900123).
const UK_PHONE_BARE = /(?<![A-Za-z0-9])(?:44[1-9]\d{8,9}|7\d{9})\b/g;

// Any other international number (+ or 00, then 8 to 15 digits), such as a caller from abroad.
const INTERNATIONAL_PHONE = /(?:\+|(?<![A-Za-z0-9])00)[1-9](?:[\s.+-]?\d){7,14}\b/g;

// UK postcodes in all six shapes (A9 9AA to AA9A 9AA), any case, with or without the space,
// or with a + for it (as in a form-encoded body).
const POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?(?:\s+|\+)?\d[A-Z]{2}\b/gi;

// Signed call-page links (core/signed-links.ts): the token is a seven-day credential.
const CALL_TOKEN = /\/c\/[0-9a-f]{32}\.[0-9a-z]{1,8}\.[A-Za-z0-9_-]{22}(?![A-Za-z0-9_-])/g;

// Fields that are call content, or a caller's details, whatever they hold: replaced whole.
const REDACTED_KEYS = new Set([
  "transcript",
  "transcript_object",
  // The same content under the names it's given in our own code, and Retell's fuller copy.
  "transcriptobject",
  "transcript_with_tool_calls",
  "transcriptwithtoolcalls",
  "summary",
  "call_summary",
  "callsummary",
  "custom_analysis_data",
  "customanalysisdata",
  "body",
  "message",
  "text",
  "content",
  "callername",
  "caller_name",
  "extractedfields",
  "extracted_fields",
]);

// Percent-encoded text (a form body, a URL) hides a number or an address from the patterns:
// %2B447700900123, jo%40example.com, XQ12%203JL.
function decodePercents(text: string): string {
  return text.replace(/%2B/gi, "+").replace(/%40/g, "@").replace(/%20/g, " ");
}

export function redactText(text: string): string {
  return (
    decodePercents(text)
      // The call link first: about one expiry in thirteen encodes to a postcode-shaped piece
      // (".tp00aa."), and redacting that alone would leave the call ID and its MAC in the log.
      .replace(CALL_TOKEN, "/c/[token]")
      .replace(EMAIL, "[email]")
      .replace(EMAIL_CUT, "[email]")
      .replace(UK_PHONE, "[phone]")
      .replace(UK_PHONE_BARE, "[phone]")
      .replace(INTERNATIONAL_PHONE, "[phone]")
      .replace(POSTCODE, "[postcode]")
  );
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
