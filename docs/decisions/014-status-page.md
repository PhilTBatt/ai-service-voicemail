# 014: Status page (Step 14)

- **Date:** 2026-11-08
- **Status:** proposed. Phil picks, or decides to wait. Nothing is set up, and every option below is free to start.

## 1. What it's for

A page that tradespeople, Ant and Phil can open to see whether AnswerMate is working. It should:

- live outside our Azure setup, so it can still say we're down when we are;
- change by itself, from a check on our API, rather than waiting for Phil to post at 2 a.m.;
- cost as little as possible.

What "down" means for callers: if our API stops answering, Twilio plays the fallback voicemail (decision 009), so callers still leave messages. The page should say so.

Nice to have, not needed at launch: our own address, such as status.brockersby.co.uk.

## 2. The options

Prices and limits from each provider's own pages, read 2026-11-08.

| Option                                                                   | Free plan                                                                                               | Changes by itself?                                                                                                             | Our own address                                                                  | Where the data is                                                                 |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Instatus**                                                             | Starter: 15 monitors, checks every 2 minutes, 200 subscribers, no custom domain                         | Yes: a failing website monitor can "create an incident, publish to your status page, or notify subscribers" (their help pages) | Pro, "from $20/mo" (the page title; the price table didn't load)                 | The US (AWS Ohio and Virginia)                                                    |
| **Better Stack**                                                         | 10 monitors and heartbeats, 1 status page, email and Slack alerts; the free check interval isn't stated | A failing monitor opens an incident and alerts whoever is on call; the docs don't say the page changes by itself               | A custom subdomain by CNAME; the docs name no plan, so it needs checking on free | The US and elsewhere, under the EU-US Data Privacy Framework and SCCs (their DPA) |
| **UptimeRobot**                                                          | 50 monitors, checks every 5 minutes, 1 basic status page                                                | Not confirmed on the pages read                                                                                                | Solo: €12 a month billed yearly (€13 monthly)                                    | A DPA exists; no location on the pages read                                       |
| **Atlassian Statuspage**                                                 | 100 subscribers, 25 components, no monitoring                                                           | No: incidents are posted by hand or through integrations                                                                       | Hobby: $29 a month                                                               | Not found on the pages read                                                       |
| **Upptime** (open source: GitHub Actions checks, a page on GitHub Pages) | Free, from a public repository                                                                          | Yes, and it opens a GitHub issue while a check fails                                                                           | Yes (a CNAME setting)                                                            | GitHub                                                                            |
| **A static page of our own** (Azure Static Web Apps, Free)               | Hosting and 2 custom domains, no SLA                                                                    | No: changed by hand                                                                                                            | Yes                                                                              | Ours                                                                              |

Why not each of the others:

- **Atlassian Statuspage:** no monitoring on any plan's page, so it's Phil posting by hand, and $29 a month for our own address.
- **Upptime:** checks no faster than every 5 minutes, and GitHub says scheduled runs "can be delayed" and, under high load, "some queued jobs may be dropped". Free minutes need a public repository (a private one uses about 3,000 paid minutes a month), and GitHub Pages' terms say it isn't for "providing commercial software as a service". Our repo is public today, but whether it should be is an open question.
- **A static page of our own:** it changes only by hand, which is what the page is meant to avoid. On Azure, it shares a cloud with the app.
- **UptimeRobot:** a good monitor, but whether the free page changes by itself wasn't confirmed, and our own address costs €12 a month.
- **Better Stack:** the strongest monitoring and on-call alerting, which overlaps with what Step 8 sets up anyway; its free plan's check interval and page behaviour aren't documented on the pages read.

## 3. Recommendation: Instatus, free (Starter)

Of the hosted services, it's the only one whose docs say a failing check updates the page by itself. It checks every 2 minutes, and it's free. The page lives at an instatus.com address until we pay for our own domain (Pro).

What it would check: our API's `/readyz`, every 2 minutes, from outside Azure. `/readyz` answers only when the database does, so it means "able to take calls". It can't make a phone call: the nightly synthetic calls (Step 14) cover a whole call.

Start without subscribers. Then no customer email addresses sit in the US, and the page is somewhere to look rather than something that messages people. With a handful of pilots, Phil texting them directly is quicker anyway.

**Confidence: medium-low.** The free plan's details come from its pricing table, whose prices didn't fully load, and nothing has been tried.

**Strongest case against:** with a handful of pilots, a status page may not be worth even a free account yet. A text from Phil reaches every customer faster than a page they have to think to open, so waiting until there are, say, 20 customers is a fair choice. Second, its data is in the US, which matters only if we add subscribers.

## 4. Next

Phil picks, or says wait. For Instatus, Phil creates the free account (it needs his email), and the check goes on once production exists (Step 8): until then there's nothing public to check.
