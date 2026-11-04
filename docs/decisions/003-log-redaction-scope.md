# 003: Log redaction scope

- **Date:** 2026-11-04
- **Status:** accepted

## Context

BUILD_PLAN Step 0 says the logger masks UK phone numbers, emails and postcodes, plus "any field named `transcript`, `summary`, `body` or `message`". Read literally, that breaks logging:

- **Winston stores each log line's own text in `message`,** so every line would read `[redacted]`.
- **Every `Error` has a `message`.** Removing it makes failures undebuggable.

Testing also showed that library errors carry large internal objects. pg attaches its whole connection (user, host, an internal `secretKey`), and HTTP clients attach the request, including `Authorization` headers.

## Decision

Implemented in `apps/api/src/redact.ts`, applied by `apps/api/src/logger.ts`:

1. **Content fields** (`transcript`, `summary`, `body`, `message`), in any letter case and at any depth, are replaced whole with `[redacted]`. Ignoring case catches Twilio's `Body`.
2. **The log line's own text, and error messages,** are pattern-redacted (phone, email, postcode) but not removed.
3. **For errors,** only plain fields (string, number, boolean) are kept, plus `name`, `message`, `stack` and `cause`. Attached objects are dropped.
4. **All other text** is pattern-redacted, including international numbers (`+` and 8–15 digits), not only UK ones.
5. **Binary data** is replaced by its size, and circular references become `[circular]`.

The email pattern uses a lookbehind so its running time stays linear. Without it, a 100,000-character string took 11.5 seconds and blocked the process. A test guards this.

## Options considered

1. **Follow the plan literally.** Discarded: every log line would be blank and every error unreadable.
2. **Drop error messages completely and log only error codes.** Discarded: most failures would be impossible to diagnose from logs.
3. **Keep all error fields.** Discarded after testing: it leaked connection details and would leak auth headers.

**Confidence:** medium-high.

**Strongest case against:** an error message from a provider can quote free text, such as part of an SMS or a caller's name. Patterns can't recognise names or sentences. The rule that follows: log IDs, never content, and never interpolate caller data into a log message.
