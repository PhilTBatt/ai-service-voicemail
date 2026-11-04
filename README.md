# CallMate

AI phone answering for UK tradespeople. A managed voice-AI platform answers the calls they divert to their CallMate number. This repo holds everything around that platform: tenants, agent configuration, post-call processing, notifications, billing, the dashboard and the infrastructure.

## Requirements

- Node.js 26 (LTS)
- Docker Desktop, for the local Postgres databases

## Getting started

From the repo root, in PowerShell:

```powershell
npm install
Copy-Item .env.example .env   # then set DATABASE_URL: the local value is in docker-compose.yml
npm run db:up
npm run check
npm run dev
```

Then open http://localhost:3000/healthz.

## Scripts

| Script            | What it does                                                    |
| ----------------- | --------------------------------------------------------------- |
| `npm run dev`     | Runs the API, restarting on file changes                        |
| `npm run check`   | Lint, format check, typecheck and tests (needs `npm run db:up`) |
| `npm run format`  | Fixes formatting                                                |
| `npm run db:up`   | Starts the dev (port 5434) and test (port 5433) databases       |
| `npm run db:down` | Stops them. Dev data is kept; `docker compose down -v` wipes it |

## Layout

```
apps/api/          Express API
apps/web/          React dashboard (not built yet)
packages/shared/   Types and schemas used by both
docs/decisions/    Decision records: what was chosen, and why
```
