# Progress

Read this at the start of every session, and update it at the end of every step.

## How we work

- Claude makes every change and explains it. Phil reviews it and makes the commit, using a short message Claude suggests.
- Everything happens on `main`: no step branches, no pull requests.
- Claude can add non-secret values to `.env` by appending, never reading it. Real secrets (API keys, tokens) Phil pastes in himself.

## Steps

| #   | Step                                         | Status      | Notes                                                                                                                        |
| --- | -------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 0   | Foundation and legacy audit                  | Done        | Deferred: `db:migrate` and `db:seed` to Step 1 (they need its migration tool); porting Twilio signature validation to Step 4 |
| 1   | Database, tenancy and row-level security     | Next        |                                                                                                                              |
| 2   | Voice platform spike                         | Not started | 🛑 Phil creates trial accounts first                                                                                         |
| 3   | Voice adapter, prompt builder and agent sync | Not started |                                                                                                                              |
| 4   | Telephony: numbers, routing and fallback     | Not started | Port Twilio signature validation from the legacy code (decision 000)                                                         |
| 5   | Post-call pipeline and data retention        | Not started |                                                                                                                              |
| 6   | Notifications                                | Not started | 🛑 Email provider decision first                                                                                             |
| 7   | Guardrails and eval harness                  | Not started |                                                                                                                              |
| 8   | Deploy: Azure, CI/CD and monitoring          | Not started | 🛑 Cost estimate before any resources                                                                                        |
| 9   | Demo line                                    | Not started |                                                                                                                              |
| 10  | Auth, roles and dashboard                    | Not started | 🛑 Auth provider decision first                                                                                              |
| 11  | Onboarding                                   | Not started |                                                                                                                              |
| 12  | Billing and usage                            | Not started |                                                                                                                              |
| 13  | Offboarding and data rights                  | Not started |                                                                                                                              |
| 14  | Reliability and load                         | Not started |                                                                                                                              |
| 15  | Launch readiness                             | Not started |                                                                                                                              |

## Decisions

| #   | Decision                                                    | Summary                                                                                 |
| --- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 000 | [Legacy code audit](decisions/000-legacy-audit.md)          | Keep signature validation, env validation, Winston and Docker; drop the rest            |
| 001 | [TypeScript runtime](decisions/001-typescript-runtime.md)   | Node 26 runs `.ts` directly; `tsc` only type-checks; TypeScript 6.0                     |
| 002 | [Postgres driver](decisions/002-postgres-driver.md)         | `pg`, because pg-boss uses it (Step 5 needs one transaction for the call and its job)   |
| 003 | [Log redaction scope](decisions/003-log-redaction-scope.md) | Content fields removed; message text and errors pattern-redacted; error objects trimmed |

Smaller calls, explained when they were made:

- Prettier with a 100-character line width.
- Node's built-in `--env-file` instead of `dotenv`.
- Local Postgres as two servers: dev on port 5434 (persistent) and test on port 5433 (in memory). They're separate because Step 1's roles are server-wide. Port 5432 is often taken.
- GitHub Actions pinned to commit SHAs.
- A single-stage Dockerfile on `node:26-slim`, running as the `node` user.

## Open questions for Phil

1. **Repo visibility.** BUILD_PLAN says private; the GitHub repo is public.
2. **Cloud sync.** `README.md` and `.env` were Windows Cloud Files entries, which suggests a sync app manages (or managed) this folder. If it still does, exclude the folder or move the repo somewhere unsynced.

## Watch list

- TypeScript 7: switch once typescript-eslint supports it (decision 001).
- `npm audit` reports a moderate `minimatch` issue inside ESLint (dev-only; the suggested fix downgrades ESLint). It should clear when ESLint updates the dependency.
- Docker base image: decide in Step 8 whether to pin `node:26-slim` to a digest.

## Reference

- **Fictional phone numbers** for tests, seeds and fixtures come from Ofcom's ranges reserved for drama: https://www.ofcom.org.uk/phones-and-broadband/phone-numbers/numbers-for-drama
- **Local databases:** dev `postgres://callmate:callmate@127.0.0.1:5434/callmate`, test `postgres://callmate:callmate@127.0.0.1:5433/callmate_test`.

## Session log (newest first)

- **2026-11-04:** Step 0 done: legacy audit, npm workspaces on Node 26, ESLint, Prettier and Vitest, zod config, local Postgres, a redacting logger, `/healthz` and `/readyz`, the Dockerfile, CI on GitHub Actions. Also stopped tracking `node_modules`.
