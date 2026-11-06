# Progress

Read this at the start of every session, and update it at the end of every step.

## How we work

- Claude makes every change and explains it. Phil reviews it and makes the commit, using a short message Claude suggests.
- Everything happens on `main`: no step branches, no pull requests.
- Claude can add non-secret values to `.env` by appending, never reading it. Real secrets (API keys, tokens) Phil pastes in himself.
- Each step's summary says what a push will trigger (see Reference below).

## Steps

| #   | Step                                         | Status      | Notes                                                                                                                                                                                                                                                                                                                                    |
| --- | -------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | Foundation and legacy audit                  | Done        | Deferred: porting Twilio signature validation to Step 4                                                                                                                                                                                                                                                                                  |
| 1   | Database, tenancy and row-level security     | Done        | dbmate migrations, three roles, RLS forced on every tenant table, `withTenant()`, number lookup function, admin module, seed                                                                                                                                                                                                             |
| 2   | Voice platform spike                         | Done        | **Retell AI** chosen (decision 007). Docs comparison, text simulations on both, Phil's web calls. Phone-path test deferred to Step 4                                                                                                                                                                                                     |
| 3   | Voice adapter, prompt builder and agent sync | Done        | `VoiceProvider` + fake + contract tests; prompt builder with per-trade snapshots; Retell adapter (live contract passes); webhook route over raw bytes; pg-boss `sync-agent` job (decision 008). Phil checks: `npm run demo:profile` then `npm run worker` creates the agent in Retell's dashboard. Not mapped: wrap-up at 6 min (Step 7) |
| 4   | Telephony: numbers, routing and fallback     | In progress | Done: Twilio adapter; routing by status; fallback voicemail (TwiML Bin via `npm run twiml:fallback`) + recording callback; reconciliation job every 15 min. 🛑 Phil: upgraded Twilio account, UK business bundle, ngrok static domain. Next: the one test number (`live-*` script) and Phil's phone tests                                |
| 5   | Post-call pipeline and data retention        | Not started | Check pg-boss can enqueue inside our own transaction (decision 002)                                                                                                                                                                                                                                                                      |
| 6   | Notifications                                | Not started | 🛑 Email provider decision first                                                                                                                                                                                                                                                                                                         |
| 7   | Guardrails and eval harness                  | Not started |                                                                                                                                                                                                                                                                                                                                          |
| 8   | Deploy: Azure, CI/CD and monitoring          | Not started | 🛑 Cost estimate before any resources. Create Azure's database roles; dbmate in the deploy job (decision 004)                                                                                                                                                                                                                            |
| 9   | Demo line                                    | Not started |                                                                                                                                                                                                                                                                                                                                          |
| 10  | Auth, roles and dashboard                    | Not started | 🛑 Auth provider decision first. Admin actions write to `audit_log` (decision 006)                                                                                                                                                                                                                                                       |
| 11  | Onboarding                                   | Not started |                                                                                                                                                                                                                                                                                                                                          |
| 12  | Billing and usage                            | Not started |                                                                                                                                                                                                                                                                                                                                          |
| 13  | Offboarding and data rights                  | Not started |                                                                                                                                                                                                                                                                                                                                          |
| 14  | Reliability and load                         | Not started |                                                                                                                                                                                                                                                                                                                                          |
| 15  | Launch readiness                             | Not started |                                                                                                                                                                                                                                                                                                                                          |

## Decisions

| #   | Decision                                                      | Summary                                                                                                                                                         |
| --- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 000 | [Legacy code audit](decisions/000-legacy-audit.md)            | Keep signature validation, env validation, Winston and Docker; drop the rest                                                                                    |
| 001 | [TypeScript runtime](decisions/001-typescript-runtime.md)     | Node 26 runs `.ts` directly; `tsc` only type-checks; TypeScript 6.0                                                                                             |
| 002 | [Postgres driver](decisions/002-postgres-driver.md)           | `pg`, because pg-boss uses it (Step 5 needs one transaction for the call and its job)                                                                           |
| 003 | [Log redaction scope](decisions/003-log-redaction-scope.md)   | Content fields removed; message text and errors pattern-redacted; error objects trimmed                                                                         |
| 004 | [Migrations and roles](decisions/004-migrations-and-roles.md) | dbmate (transactional, plain SQL); owner and app roles created as environment setup                                                                             |
| 005 | [Tenancy schema](decisions/005-tenancy-schema.md)             | RLS forced on every tenant table; `tenant_id` on child tables with two-column foreign keys                                                                      |
| 006 | [Cross-tenant access](decisions/006-cross-tenant-access.md)   | A narrow lookup function for webhooks; an admin role with explicit policies; one module                                                                         |
| 007 | [Voice platform](decisions/007-voice-platform.md)             | **Draft.** Retell vs Vapi from the docs; hands-on tests pending; Phil chooses                                                                                   |
| 008 | [Job queue](decisions/008-job-queue.md)                       | pg-boss owns its schema as the app role; sync-agent idempotent on tenant + version via the exclusive policy                                                     |
| 009 | [Telephony](decisions/009-telephony.md)                       | Dial-to-SIP (API routes by status; Twilio fallback URL covers outages); REST via fetch, signatures via SDK; upgraded Twilio account needed; ngrok static domain |

Smaller calls, explained when they were made:

- Prettier with a 100-character line width.
- Node's built-in `--env-file` instead of `dotenv`.
- Local Postgres as two servers: dev on port 5434 (persistent) and test on port 5433 (in memory). They're separate because the roles are server-wide. Port 5432 is often taken.
- Local and CI databases accept password-free logins, so no credential-looking strings live in the repo.
- GitHub Actions pinned to commit SHAs.
- A single-stage Dockerfile on `node:26-slim`, running as the `node` user.
- Seed tenants have fixed IDs, so `db:seed` can be re-run; it refuses to run in production.

## Open questions for Phil

1. **Repo visibility.** BUILD_PLAN says private; the GitHub repo is public.
2. **Cloud sync.** `README.md` and `.env` were Windows Cloud Files entries, which suggests a sync app manages (or managed) this folder. If it still does, exclude the folder or move the repo somewhere unsynced.

## Watch list

- TypeScript 7: switch once typescript-eslint supports it (decision 001).
- `npm audit` reports a moderate `minimatch` issue inside ESLint (dev-only; the suggested fix downgrades ESLint). It should clear when ESLint updates the dependency.
- Docker base image: decide in Step 8 whether to pin `node:26-slim` to a digest.

## Reference

- **Fictional phone numbers** for tests, seeds and fixtures come from Ofcom's ranges reserved for drama: https://www.ofcom.org.uk/phones-and-broadband/phone-numbers/numbers-for-drama
- **Local databases** (no passwords; only reachable from this machine): dev on port 5434, test on port 5433. Connection strings for each role are at the top of `docker-compose.yml`. Editing `roles.sql` needs `docker compose down -v`, which wipes dev data; re-run `npm run db:migrate` and `npm run db:seed` afterwards.
- **What a push to `main` triggers:** CI, and GitGuardian secret scanning (the repo is public), so keep secret-looking strings out of committed files. A Render service for the old app used to auto-deploy on push; Phil reports it's handled (2026-11-04).

## Session log (newest first)

- **2026-11-06:** Step 4: fallback voicemail as a TwiML Bin, recording callback route, voicemail storage (idempotent on CallSid), reconcile-voicemails scheduled job.
- **2026-11-06:** Step 4: Twilio adapter (decision 009, Dial-to-SIP); call routing by tenant status with per-call open/holiday variables; `attachNumber` replaced by `registerInboundCall`. Waiting on Phil's Twilio account and bundle.
- **2026-11-06:** Step 3 done: VoiceProvider interface, fake and contract tests; trade templates and prompt builder; Retell adapter (contract passes against real Retell); webhook route over raw bytes; pg-boss installed by migration under the app role; sync-agent job and worker. Opening now ends with "How can I help?" (Phil).
- **2026-11-06:** Step 2 done: Phil chose Retell. His voice calls found the greeting clipped and the gas script interruptible then paraphrased; fixes applied to the spike agent and recorded for Step 3.
- **2026-11-06:** Step 2: Phil's first web calls fetched from both APIs. Retell p90 latency 1.9 s and heard "double o" correctly; Vapi p90 2.7 s and mis-heard the number, though half the price per minute. Recommendation: Retell, medium confidence; Phil to confirm.
- **2026-11-05:** Step 2: text simulations on both platforms (Retell 6/6 after fixing a global-node loop; Vapi 6/6 after narrowing the water rule). Retell rate limit 30 req/10 s. Twilio SIP Disaster Recovery URL covers platform outages. Waiting on Phil's voice test calls.
- **2026-11-04:** Step 2 started: docs research for Retell vs Vapi (decision 007 draft). Found Vapi's pay-as-you-go concurrency is 4, not 10.
- **2026-11-04:** Step 1 done: dbmate migrations; owner, app and admin roles; all tenant tables with forced RLS; `withTenant()`; the number lookup function; the cross-tenant admin module; seed data. Also fixed GitGuardian and Render fallout (no real secrets were ever committed), and removed passwords from local and CI databases.
- **2026-11-04:** Step 0 done: legacy audit, npm workspaces on Node 26, ESLint, Prettier and Vitest, zod config, local Postgres, a redacting logger, `/healthz` and `/readyz`, the Dockerfile, CI on GitHub Actions. Also stopped tracking `node_modules`.
