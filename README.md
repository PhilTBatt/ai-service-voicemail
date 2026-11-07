# CallMate

AI phone answering for UK tradespeople. A managed voice-AI platform (Retell) answers the calls they divert to their CallMate number; this repo holds everything around it: tenants, agent configuration, call routing, post-call processing, notifications, evals, billing, the dashboard and the infrastructure.

Working name for the product: AnswerMate. `callmate` stays the internal codename in code and config.

## Requirements

- Node.js 26 (LTS)
- Docker Desktop, for the local Postgres databases
- For calls and texts locally: an ngrok static domain (`PUBLIC_BASE_URL`), a Retell API key and a Twilio account. Everything else runs without them.

## Getting started

From the repo root, in PowerShell:

```powershell
npm install
Copy-Item .env.example .env   # then fill it in; the local database URLs are in docker-compose.yml
npm run db:up
npm run db:migrate
npm run db:seed
npm run check
npm run dev                    # the API, in one terminal
npm run worker                 # the background jobs, in another
```

Then open http://localhost:3000/healthz.

## How it fits together

- **API** (`apps/api/src/server.ts`): answers webhooks fast and never does slow work. Twilio asks it how to route a call; Retell tells it a call ended; the tradesperson's phone texts it commands; a browser opens a signed call page.
- **Worker** (`apps/api/src/worker.ts`): runs the pg-boss jobs: agent sync to Retell, post-call extraction with the LLM, the texts and emails, emergency texts, reconciliation of missed calls and voicemails, retention.
- **Queue**: pg-boss, in the same Postgres. Jobs are queued inside the transaction that creates the row they're about, so a row and its job always exist together.
- **Row-level security**: every tenant table is isolated by Postgres policies; the API connects as a role that can't bypass them. The only cross-tenant code is `apps/api/src/db/cross-tenant.ts`.

## Scripts

| Script                          | What it does                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `npm run dev`                   | Runs the API, restarting on file changes                                                                           |
| `npm run worker`                | Runs the job worker                                                                                                |
| `npm run check`                 | Lint, format check, typecheck and tests (needs `npm run db:up`)                                                    |
| `npm test`                      | Tests only, against the test database                                                                              |
| `npm run e2e`                   | Browser smoke tests: Chromium drives the dashboard against the real API and test database (sign-in is a stand-in)  |
| `npm run e2e:install`           | Once per machine: downloads the Chromium that `npm run e2e` uses                                                   |
| `npm run format`                | Fixes formatting                                                                                                   |
| `npm run db:up` / `db:down`     | Starts or stops the dev (port 5434) and test (port 5433) databases; `docker compose down -v` wipes dev data        |
| `npm run db:migrate`            | Applies new migrations to the dev database (as the owner role)                                                     |
| `npm run db:status`             | Shows which migrations have run                                                                                    |
| `npm run db:new -- <name>`      | Creates an empty migration file                                                                                    |
| `npm run db:seed`               | Seeds the demo tenants (fictional data; refuses to run in production)                                              |
| `npm run demo:profile`          | Saves the demo tenant's agent profile and queues its sync to Retell                                                |
| `npm run twiml:fallback`        | Prints the two TwiML Bins for the static fallback voicemail                                                        |
| `npm run evals`                 | Runs the caller personas against the current prompt with the real model, under a cost cap                          |
| `npm run live-buy-test-number`  | Searches for, and with `--confirm` buys, a UK number. Spends money: guarded twice                                  |
| `npm run live-evals-retell`     | Runs the personas as Retell batch tests against a synced agent. Spends Retell credit                               |
| `npm run live-configure-number` | Repoints the demo number at the current public URL and voicemail bin, or adopts a console-bought one (`--confirm`) |

Anything named `live-*` touches a paid service and must be run deliberately.

## Layout

```
apps/api/          Express API and the worker
  src/core/        pure domain logic: prompt builder, scripts, routing, guardrails, notifications, usage
  src/providers/   seams and adapters: voice (Retell), telephony (Twilio), SMS, email, LLM (Anthropic), with fakes
  src/jobs/        pg-boss jobs: sync-agent, process-call, notify-*, reconcile-*, retention, dead-letter
  src/db/          migrations, roles, withTenant(), the cross-tenant module
  src/routes/      webhooks (Retell, Twilio) and the signed call page
  src/evals/       the eval harness
apps/web/          React dashboard (not built yet)
packages/shared/   Types and schemas used by both
evals/personas/    caller personas as YAML
docs/              BUILD_PLAN.md, PROGRESS.md (start here), RUNBOOK.md, DEMO.md, decisions/
```

## Working rules

See `CLAUDE.md` for the conventions and the safety rules: fictional data only (Ofcom drama numbers), no outbound messages outside the allowlist except in production, never log call content or contact details, and no spending without a deliberate `live-*` script.
