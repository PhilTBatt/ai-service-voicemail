# 000: Legacy code audit

- **Date:** 2026-11-04
- **Status:** accepted
- **Scope:** everything in the repo before Step 0: `src/*.ts`, `package.json`, `tsconfig.json`, `Dockerfile`, `.dockerignore`, `.gitignore`, `README.md`.

## Summary

The old code is a single Express app. It answers a Twilio call, records up to 10 seconds of voicemail, then does all the work inside the recording webhook before replying: download the audio, transcribe it with Whisper, summarise it with gpt-4o-mini, email it through Gmail and text it through Twilio. About 300 lines in 6 files, with no tests.

Four pieces are worth keeping, each with changes: Twilio signature validation, env validation, Winston logging and the Dockerfile. The rest is replaced, as Appendix E says.

## File-by-file verdicts

| File                                  | What it does                                                                        | Verdict (Appendix E)                | Where it goes                                                   |
| ------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------- |
| `src/middleware.ts`                   | Validates `X-Twilio-Signature` using `WEBHOOK_BASE_URL + req.originalUrl`           | **Keep**                            | Step 4, inside the Twilio adapter                               |
| `src/config.ts`: env check            | Lists required variable names; exits naming the missing ones, never printing values | **Keep the idea**, rewrite with zod | Step 0, `apps/api/src/config.ts`                                |
| `src/config.ts`: Winston              | JSON logger writing to console and `logs/*.log`                                     | **Keep**, add redaction             | Step 0, `apps/api/src/logger.ts`                                |
| `src/config.ts`: Nodemailer           | Gmail transport using an app password                                               | **Drop**                            | Step 6 picks a transactional email service                      |
| `src/config.ts`: Twilio client        | Created at import time                                                              | **Keep** (SMS)                      | Step 6, `SmsProvider`                                           |
| `src/ai.ts`: `transcribeAudio`        | Calls Whisper over raw `fetch`                                                      | **Drop**                            | The voice platform provides transcripts                         |
| `src/ai.ts`: `summariseCall`          | gpt-4o-mini, free-text output                                                       | **Change**                          | Step 5: current small model, pinned version, zod-validated JSON |
| `src/utils.ts`: `sendSmsNotification` | Twilio `messages.create`                                                            | **Keep**                            | Step 6                                                          |
| `src/utils.ts`: `sendVoicemailEmail`  | Gmail HTML email                                                                    | **Drop**                            | Step 6                                                          |
| `src/utils.ts`: `fetchRecordingAudio` | Downloads the recording with API-key basic auth                                     | **Drop** for now                    | Possibly reused by Step 4's reconciliation job                  |
| `src/routes.ts`                       | Voicemail-only flow, all work done inline                                           | **Drop**                            | Steps 3–5 (live agent, webhook, then queue)                     |
| `Dockerfile`                          | Single stage on `node:20`                                                           | **Keep**, rework                    | Step 8 builds on it; findings below                             |

## What's worth keeping, and what to fix when it moves

**Twilio signature validation (`middleware.ts`).**

- What's right: it builds the URL from a configured base URL, not from `req.protocol` or `req.host`. That's exactly the Step 4 gotcha about proxies, so the old code already handles it.
- To fix:
  - Rename `WEBHOOK_BASE_URL` to `PUBLIC_BASE_URL`, as the plan does.
  - `req.headers["x-twilio-signature"] as string` hides the case where the header arrives as an array. Narrow the type properly instead.
  - It has no tests. Step 4 adds fixtures for a valid signature, a bad signature and a tampered body.

**Env validation (`config.ts`).**

- What's right: it fails fast and names the missing variables without printing any values. That matches Step 0's requirement.
- To fix:
  - It only checks that a variable exists, not its format. Zod adds format checks (a URL is a URL, a number is in E.164).
  - It runs `process.exit(1)` and creates the Twilio and Nodemailer clients **at import time**. Importing the module therefore needs every secret present, so it can't be unit-tested. The new version exports a `loadConfig(env)` function that throws, and only the entry point decides to exit.
  - It's one module mixing config, the logger and API clients. Split them up.

**Winston logging (`config.ts`).**

- What's right: the base format is timestamp, error stacks and JSON.
- To fix:
  - The Console transport overrides that with `colorize()` + `simple()`, so console output **isn't** JSON. In a container, console output is the only output that matters.
  - The file transports write to `logs/`. Containers should log to stdout only, and Azure collects it from there.
  - **There's no redaction, and the code logs personal data.** Specifically:
    - `routes.ts`: the caller's number (`from`) on every recording, and the whole Twilio request body in `/api/fallback` (`From`, `To`, `Caller`…)
    - `ai.ts`: the first 80 characters of every transcript (`preview`), twice
    - `ai.ts`: the full Whisper error body
  - **Gotcha (your laptop):** `logs/combined.log` and `logs/error.log` exist locally and probably hold real callers' numbers and transcript snippets. I haven't opened them. They were never committed (checked in git history), but delete them once you're sure you don't need them.

**Dockerfile.**

- What's right: it's simple and works.
- To fix (Step 8, unless Step 0's CI needs it sooner):
  - `node:20` reached end of life in April 2026. Pin the same Node LTS as `package.json` `engines`.
  - It's single-stage, so devDependencies and the TypeScript source ship in the runtime image. A multi-stage build with `npm ci` and `npm ci --omit=dev` makes the image smaller and its contents reproducible.
  - `RUN chmod +x node_modules/.bin/tsc` works around an executable-permission error. I don't know the root cause from the history; my guess is that a clean `npm ci` inside the image makes it unnecessary, but that's unverified.
  - It runs as root. The official image has a `node` user; use `USER node`.
  - `CMD ["npm", "start"]` puts npm between the container and Node, and npm may not pass on `SIGTERM`. Azure sends `SIGTERM` on shutdown, so in-flight webhooks could be killed. Use `CMD ["node", "dist/server.js"]`.

## Problems in the dropped code (so they don't come back)

- **Everything runs inside the webhook.** Download, Whisper, the LLM, email and SMS all happen before the reply to Twilio. Twilio gives up on a webhook after 15 seconds, and a failure anywhere means the message is lost. Step 5 fixes this: store the call, enqueue a job, return 2xx.
- **It falls back to the raw transcript.** If summarising fails, `summariseCall` returns the full transcript, which then goes out by SMS. Step 5 replaces this with "Couldn't summarise, see the transcript".
- **HTML injection in the email.** The transcript and caller ID are interpolated into HTML without escaping.
- **Unpinned model and free-text output.** `gpt-4o-mini` with a prose answer can't be validated. Step 5 pins the model version and validates JSON output with zod.
- **The fallback lives on the same server.** `/api/fallback` is served by the same API it's a fallback for, so when the API is down there's no fallback. Step 4 hosts it separately.
- **Hard-coded greeting and a 10-second recording cap.** Both are replaced by per-tenant scripts (Appendix A) and a 2-minute fallback recording.

## Dependencies

| Package                           | Verdict                                                                                 |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| `express` 5, `winston`, `twilio`  | Keep                                                                                    |
| `typescript`                      | Listed in both `dependencies` and `devDependencies`. Keep it in dev only                |
| `tsx`                             | Keep (dev runner)                                                                       |
| `dotenv`                          | Probably replace with Node's built-in `--env-file`, decided in the Step 0 config change |
| `openai`                          | Drop for now. Step 5 chooses the LLM provider                                           |
| `nodemailer`, `@types/nodemailer` | Drop                                                                                    |
| `axios`                           | Drop: unused (no imports in `src/`)                                                     |
| `ts-node-dev`                     | Drop: unused (`dev` uses `tsx`)                                                         |

## Decision

Restructure into the workspaces layout (`apps/api`, `apps/web`, `packages/shared`). Carry over the four kept pieces as each step needs them, and delete the rest of `src/` once `apps/api` has replaced it.

- **Options considered:**
  1. **Refactor `src/` in place,** moving files into the new layout.
     - Discarded because almost every file changes shape (the import-time side effects, the inline pipeline), so the git history it would preserve isn't worth much.
  2. **Rewrite and port the kept pieces (chosen).**
  3. **Keep the old app running alongside the new one** until the new one reaches feature parity.
     - Discarded because nothing in production depends on it. If I've got that wrong and the old number is still in use, tell me, and this changes.
- **Confidence:** high.
- **Strongest case against:** a rewrite can quietly lose behaviour the old code got right by accident. To reduce that risk, the "worth keeping" section above lists those behaviours explicitly, and each one gets a test when it's ported.
