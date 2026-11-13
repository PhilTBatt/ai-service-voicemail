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

The real app, routes and database code, against the test database, with the fakes for every outside service: Twilio, the voice platform, the login provider. The fakes check webhook signatures with fixed test keys, and the k6 script signs with the same keys, so signature checking is part of what's measured. Nothing leaves the machine.

**The worker runs too (2026-11-13),** in its own process as in production (`testing/load-worker.ts`): the real job handlers at production's concurrency (`WORK_OPTIONS`) and pool sizes, with fakes that take about as long as the real services. The model takes 2 s a call (`LOAD_LLM_MS`; our estimate of a short extraction on the small model, not measured), Twilio and Postmark 300 ms a send. Each business's texts and emails go through the whole send path, outbound allowlist included, to the fakes. When k6 finishes, the runner waits up to three minutes for the worker to text every call the run made, then gives the time from each call being stored to its text being sent, and **fails the run if any text took over 60 seconds** (BUILD_PLAN Step 6) or never went (`LOAD_TEXT_SECONDS` overrides the limit). The run's start is taken from the database's clock, which stamps the calls: Docker's clock had drifted minutes from the PC's after a sleep, and the seeded history counted as the run's calls until it was.

The worker's side is also tested on its own: `worker-jobs.concurrency.test.ts` runs the worker's real job registration against the test database with fakes, eight calls at once, and checks they run four at a time with every message sent once. Still not measured: the real LLM's time per call.

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

**With the worker running (2026-11-13, the same PC):** 977 requests, none failed, every check passed. The API's p95s rose a little with the worker sharing the database: the voice webhook 66 ms steady and 309 ms in the burst, call ended 34 ms and 352 ms, the dashboard 22 to 34 ms. **Every one of the run's 94 calls was texted: median 15.0 s after the call ended, p95 36.2 s, slowest 38.0 s, none over 60.** A second run the same morning: 95 calls, median 17.4 s, p95 38.2 s, slowest 41.2 s. So about 20 s of margin under the 60, not more. The burst of 70 calls at once sets those numbers: four calls processed at a time, at 2 s each, take about 35 s to clear 70. The steady calls alone come in at a few seconds. A slower model, or a burst much bigger than 70, is what would push the slowest past 60 s; raising process-call's concurrency (`WORK_OPTIONS`) is the lever, within the database connections it has (each call holds one only for its short transactions).

## 7. Confidence and the case against

**Confidence: medium.** The method follows the plan; the traffic numbers rest on two assumptions (call length, dashboard use) that real calls will correct.

**Strongest case against:** it measures our API and database on one PC, not Azure, and not the providers. Production adds network hops and a database server sized for cost (decision 011), and the fakes answer instantly where Retell's register-call takes real time. The steady rate is low enough that the burst is the real test. Rerun it on the production setup in Step 8 (the same script works against any URL), and again when real call lengths are known.
