# 013: Load tests: the traffic, the tool and the limits (Step 14)

- **Date:** 2026-11-07
- **Status:** accepted 2026-11-07 (Claude, under the plan; Phil can change any number below)
- **Code:** `apps/api/load/k6-load-test.js` (the test), `apps/api/src/testing/load-server.ts` (the API it runs against), `apps/api/src/scripts/run-load-test.ts` (`npm run load`), `.github/workflows/load.yml` (CI, manual)

## 1. What the plan asks

"k6 tests for the webhook and dashboard APIs at 10 times the expected peak (Appendix F). Report the p95." And "k6 thresholds in CI, on a manual trigger."

## 2. The traffic

Appendix F gives the busy-hour traffic per business (0.024 Erlangs) and the lines needed for it at 0.1% blocking (about A + 3√A). It doesn't say which customer count is "expected", or how long a call lasts. My assumptions, each a setting:

| Setting                            | Default                                     | Why                                                                                                                       |
| ---------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Businesses (`LOAD_CUSTOMERS`)      | 100                                         | The scale decision 007 sizes the voice platform for, and where the plan reconsiders a custom voice pipeline               |
| Average call (`LOAD_CALL_MINUTES`) | 2 minutes                                   | An assumption: there are no real call lengths yet. A message-taking call is short, and demo calls are capped at 3 minutes |
| Dashboard use                      | twice an hour per business in the busy hour | An assumption: a tradesperson checking messages between jobs                                                              |
| Multiplier (`LOAD_MULTIPLIER`)     | 10                                          | The plan                                                                                                                  |

What that gives, for 100 businesses: 2.4 Erlangs, about 7 lines, so:

- **steady calls:** 12 a minute (1.2 a minute in the busy hour, times 10), each sending the webhooks a real call sends us: Twilio's voice webhook, the platform's call-ended event, the dial status, and two delivery receipts for the summary text;
- **a burst:** 70 calls starting in the same moment (7 lines, times 10), 30 seconds in;
- **dashboard:** 34 page opens a minute, each three requests (who am I, the calls, one call).

## 3. The tool: k6 from its Docker image

| Option                                   | Why not                                                                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **k6 in Docker (chosen)**                | Nothing to install: Docker already runs the databases. Pinned to `grafana/k6:2.3.0`, the latest stable release on 2026-11-07 |
| k6 installed on the machine              | One more install for Phil, and a version that drifts from CI's                                                               |
| An npm load tool (autocannon, Artillery) | The plan names k6, and k6's thresholds and scenarios fit what's asked                                                        |
| Grafana Cloud k6                         | An account and a bill, for nothing a local run can't show at this size                                                       |

## 4. What runs against what

The real app, routes and database code, against the test database, with the fakes for every outside service: Twilio, the voice platform, the login provider. The fakes check webhook signatures with fixed test keys, and the k6 script signs with the same keys, so signature checking is part of what's measured. Nothing leaves the machine. The worker isn't running, so jobs queue up unprocessed, as they would for a minute in a busy hour.

The worker's side is tested on its own (2026-11-11): `worker-jobs.concurrency.test.ts` runs the worker's real job registration against the test database with fakes, eight calls at once with an LLM that takes 2 s, and checks they run four at a time with every message sent once. Its concurrency (`WORK_OPTIONS` in `worker-jobs.ts`) takes process-call from about 5 to 12 calls a minute to 20 to 48, against about 12 in the busy hour of 1,000 businesses. Not yet measured: the worker under k6's traffic, and the real LLM's time per call.

## 5. The limits (thresholds)

- Errors under 1% and checks above 99%.
- Steady traffic: the voice webhook under 500 ms at p95 (the caller is ringing while we answer it), the call-ended event under 1 s, the dial status and receipts under 500 ms.
- The burst: under 3 s at p95. Every call in it waits its turn for one of the pool's 10 database connections, and Twilio waits 15 s before giving up on us.
- Dashboard: under 800 ms at p95.

They're loose enough not to fail on a slower CI machine, and tight enough to catch a real slowdown (an unindexed query, a lock).

## 6. First results (2026-11-07, Phil's PC, local Docker Postgres)

977 requests, none failed, every check passed.

| Request                                | p95             |
| -------------------------------------- | --------------- |
| Voice webhook, steady                  | 65 ms           |
| Call ended, steady                     | 42 ms           |
| Dial status, steady                    | 6 ms            |
| Delivery receipt, steady               | 7 ms            |
| Voice webhook, 70 at once              | 190 ms          |
| Call ended, 70 at once                 | 211 ms          |
| Dashboard: who am I / calls / one call | 18 / 29 / 23 ms |

A first run, with k6's image still cold, gave 408 ms for the voice webhook across both scenarios.

## 7. Confidence and the case against

**Confidence: medium.** The method follows the plan; the traffic numbers rest on two assumptions (call length, dashboard use) that real calls will correct.

**Strongest case against:** it measures our API and database on one PC, not Azure, and not the providers. Production adds network hops and a database server sized for cost (decision 011), and the fakes answer instantly where Retell's register-call takes real time. The steady rate is low enough that the burst is the real test. Rerun it on the production setup in Step 8 (the same script works against any URL), and again when real call lengths are known.
