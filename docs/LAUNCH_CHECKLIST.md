# Launch checklist (BUILD_PLAN Step 15)

**Where things stand (2026-11-08): not ready to launch.** Most technical items need production, which needs the Azure subscription (Step 8), and none of Phil's items are closed yet.

Claude keeps the technical items up to date, each with its evidence. Phil closes his own items: they're listed here, and Claude doesn't do them.

## Technical items

| Item                                                                  | Status                 | Evidence so far                                                                                                                                                                                                                                                       | Still to do                                                                                                                            |
| --------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Tests and evals pass                                                  | Partly                 | `npm run check`: 815 tests pass, with the 14 live tests skipped (2026-11-08). `npm run e2e`: 8 browser tests pass (2026-11-07). CI runs both on every push to `main`                                                                                                  | The evals: Phil approves the Appendix A wording, then the first eval run (Step 7). The live tests, run once against the real providers |
| Every alert has fired at least once in testing                        | Done in tests          | Each of the 14 alerts in `apps/api/src/alerts.ts` is made to fire by a test (table below), and `alerts.test.ts` fails if any alert has no test or no runbook entry                                                                                                    | In production, one alert seen arriving on Phil's phone (Step 8)                                                                        |
| The fallback voicemail and the kill switch, tested in production      | Waiting for production | Tested locally: with the kill switch on, or the voice platform unreachable, the caller is sent to the voicemail (`core/routing.test.ts`, `routes/twilio.test.ts`)                                                                                                     | In production: a real call with the kill switch on, and one with the API stopped (Twilio's fallback URL takes over)                    |
| The retention and reconciliation jobs have run                        | Waiting for production | Tested against the test database (`jobs/retention.test.ts`, `jobs/reconcile-calls.test.ts`, `jobs/reconcile-voicemails.test.ts`)                                                                                                                                      | Their first scheduled runs in production, with the log lines                                                                           |
| A backup has been restored                                            | Waiting for production | The local backup and restore commands (RUNBOOK section 15) worked on the test database on 2026-11-07                                                                                                                                                                  | The restore drill: a production backup restored to a scratch server, and how long it took                                              |
| Secrets exist only in Key Vault                                       | Waiting for production | Locally, secrets live only in `.env`, which git ignores, and GitGuardian scans every push                                                                                                                                                                             | Key Vault set up (Step 8), production reading from it, and nothing else holding the secrets                                            |
| The outbound allowlist is on outside production and off in production | Partly                 | `core/outbound-allowlist.test.ts`: outside production, only listed numbers and addresses get messages; in production, everyone does                                                                                                                                   | Production running with `NODE_ENV=production`, and the allowlist on wherever else the service runs                                     |
| Measured cost per minute, against the research estimate               | Waiting for real calls | The Admin page estimates each business's monthly cost from real usage, at prices dated 2026-11-07 (`apps/api/src/core/prices.ts`). The nearest figures in the repo: Retell lists $0.07–$0.31 a minute, and the Step 2 spike spent about $0.15 a minute (decision 007) | A month of real calls, then their cost per minute against the research's estimate. That figure isn't in the repo: Phil to supply it    |

### Each alert and the test that fires it

| Alert                            | Test                                                       |
| -------------------------------- | ---------------------------------------------------------- |
| `job-dead-lettered`              | `jobs/dead-letter.test.ts`                                 |
| `voice-platform-unreachable`     | `routes/twilio.test.ts`                                    |
| `agent-sync-failed`              | `jobs/sync-agent.test.ts`                                  |
| `call-extraction-failed`         | `jobs/process-call.test.ts`                                |
| `summary-judge-failed`           | `jobs/process-call.test.ts`                                |
| `guardrail-hit`                  | `jobs/process-call.test.ts`                                |
| `notification-no-mobile`         | `jobs/notify-sms.test.ts`, `jobs/notify-emergency.test.ts` |
| `notification-no-email`          | `jobs/notify-email.test.ts`                                |
| `sms-undelivered`                | `routes/twilio.test.ts`                                    |
| `recipient-opted-out`            | `routes/twilio.test.ts`                                    |
| `email-bounced`                  | `routes/postmark.test.ts`                                  |
| `email-spam-complaint`           | `routes/postmark.test.ts`                                  |
| `number-bought-not-recorded`     | `admin/test-number.test.ts`                                |
| `deletion-confirmation-not-sent` | `jobs/offboarding.test.ts`                                 |

Test paths are under `apps/api/src/`.

## Phil's items

| Item                                             | Status | Notes                                                                                                                         |
| ------------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Solicitor-approved terms, DPA and privacy notice | Open   | Until they're in, only test businesses can go live: then set `approved` and their versions in `packages/shared/src/signup.ts` |
| ICO fee paid                                     | Open   |                                                                                                                               |
| Insurance                                        | Open   |                                                                                                                               |
| The Ofcom position confirmed                     | Open   |                                                                                                                               |
| Trademark check                                  | Open   | AnswerMate and Brockersby are working names                                                                                   |
| BrightStar consent on file                       | Open   |                                                                                                                               |
| Ant's agreement signed                           | Open   |                                                                                                                               |
| VAT status                                       | Open   | Billing (Step 12) adds VAT only once a VAT number and date are entered                                                        |

## Still open from earlier steps

Not on the plan's list for this step, but launch needs them too (from PROGRESS):

- **Step 4:** Twilio's primary compliance profile, the second TwiML bin as `FALLBACK_VOICEMAIL_URL`, a test number, then the phone tests.
- **Step 5:** the live extraction test.
- **Step 6:** the live check: a real test call, with its text and email within 60 s.
- **Step 7:** the Appendix A wording approved, and the first eval runs.
- **Step 8:** the Azure subscription, then production.
- **Step 9:** the demo number, the demo inbox and Ant's mobile, then the 20-call check.
- **Step 12:** a GoCardless sandbox account, and the decisions on Stripe and on bundles.
- **Step 13:** how long to keep billing records (with Phil's accountant).
- **Step 14:** the status page (decision 014), the synthetic calls' budget, and the restore drill.
