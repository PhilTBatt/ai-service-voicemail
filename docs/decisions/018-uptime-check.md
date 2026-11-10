# 018: The external uptime check

**Date:** 2026-11-10 · **Status:** proposed, for Phil to pick · **BUILD_PLAN:** Step 8, Monitoring

## The question

The service can email about anything it notices (alerts, decision in PROGRESS 2026-11-10), except its own absence. Something outside Azure has to ask it, regularly, whether it's there: the plan's "external uptime check on `/healthz`", with the service chosen as a decision.

Two addresses, both already there, say everything an outside check needs:

- `GET /readyz`: 200 when the API is up and can reach the database; 503 when it can't.
- `GET /healthz/worker`: 200 while the worker has checked in within the last two minutes; 503 once it hasn't. One plain HTTP check therefore covers the worker too, with nothing to install.

(`/healthz` itself is Azure's liveness probe and deliberately checks nothing; the two above are the ones worth watching.)

## Options

| Option                                                 | Cost                                                                             | For                                                                                                          | Against                                                                                                                                                   |
| ------------------------------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **UptimeRobot, free plan**                             | £0 (50 monitors, checks every 5 minutes, email alerts; SMS costs)                | Nothing to deploy; a status page if wanted; checks come from outside Azure, so an Azure-wide problem is seen | 5-minute gaps on the free plan; a third account to keep track of; alerts by email only, unless paid                                                       |
| Better Stack, free plan                                | £0 (10 monitors, every 3 minutes, email; phone-call alerts on paid)              | Faster checks; a nicer incident view                                                                         | Same third-party account; the free plan's limits have changed more than once                                                                              |
| Azure Monitor availability test (Application Insights) | About £1–3 a month per test at 5-minute frequency, plus an App Insights resource | Stays inside Azure; the same action group as any future Azure alerts; in Bicep                               | Checks from Azure's own regions, so an Azure-wide outage can go unseen; a new resource and a cost for what two free checks do; more Bicep to maintain     |
| Healthchecks.io (dead-man's switch)                    | £0 (20 checks)                                                                   | The classic fit for a worker: it pings, and silence raises the alarm                                         | Needs code in the worker to ping it; `/healthz/worker` already turns the heartbeat into an HTTP status, so this adds a second mechanism for the same fact |

## Recommendation

**UptimeRobot, free plan, two monitors:** `https://callmate-api.greengrass-a4449d88.uksouth.azurecontainerapps.io/readyz` and `.../healthz/worker`, HTTP(s) type, every 5 minutes, alerting the same address as `ALERT_EMAIL`. It costs nothing, needs no code or infrastructure, watches from outside Azure, and the worker check comes free with it.

**Confidence:** moderate to high. The free tiers of these services do change; if UptimeRobot's does, Better Stack is the like-for-like swap.

**Strongest case against:** five minutes is a long time for a phone line to be down unnoticed, and a paid plan or Azure's own test would check every minute. For a demo line and the first few businesses, five minutes is proportionate; revisit at the first paying customer.

## What it needs from Phil

A UptimeRobot account (any email), and the two monitors set up as in RUNBOOK section 16. Nothing in the repository changes.
