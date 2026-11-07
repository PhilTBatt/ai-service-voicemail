# Runbook

How to run the system locally, make a test call, and read what happened. Written for Phil; production steps are added at Step 8.

## 1. Before the first call

Once, in this order:

| Step                          | Command or action                                                                                                                                                | Done when                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Databases up and migrated     | `npm run db:up` then `npm run db:migrate`                                                                                                                        | `npm run db:status` shows nothing pending                           |
| Demo tenants seeded           | `npm run db:seed`                                                                                                                                                | No error; "Ant's Plumbing" exists                                   |
| `.env` filled in              | See `.env.example` for each name                                                                                                                                 | `npm run check` passes                                              |
| Tunnel running                | `ngrok http --domain=<your static domain> 3000` in its own terminal                                                                                              | `PUBLIC_BASE_URL` in `.env` matches it exactly                      |
| Fallback voicemail bins       | `npm run twiml:fallback` (bin 1), then `npm run twiml:fallback -- --done-url <bin 1 URL>` (bin 2)                                                                | Bin 2's URL is `FALLBACK_VOICEMAIL_URL`                             |
| Regulatory bundle approved    | Twilio console, Regulatory Compliance                                                                                                                            | `TWILIO_BUNDLE_SID` and `TWILIO_ADDRESS_SID` in `.env`              |
| Demo agent synced to Retell   | Start the worker (below), then `npm run demo:profile`                                                                                                            | Worker logs "Agent synced"; the agent appears in Retell's dashboard |
| A number bought               | `npm run live-buy-test-number -- --search 0113`, then `--buy <number>`, then `--buy <number> --confirm` (with `TWILIO_PURCHASES_ENABLED=true` for that run only) | The script prints "Bought ... and assigned it to the demo tenant"   |
| Your mobile allowed for texts | `OUTBOUND_ALLOWLIST=+44...` in `.env`, and the demo tenant's notification mobile set to it (ask Claude for the one-line update)                                  | A test call texts you                                               |

If the tunnel domain or a bin ever changes: `npm run live-configure-number -- --confirm` repoints the number.

## 2. Every session

Two terminals from the repo root, plus the tunnel, and a third for the dashboard:

```powershell
npm run dev       # the API, restarts on file changes
npm run worker    # the jobs; restart it by hand after code changes
npm run dev:web   # the dashboard at http://localhost:5173, reloads on file changes
```

Before pushing, `npm run check` runs lint, formatting, types and tests. `npm run e2e` runs the browser smoke tests (a few seconds plus start-up; it uses the test database, so don't run it while `npm test` is running). The first time on a machine, run `npm run e2e:install` to download its browser.

The API logs "API listening" and the worker logs "Worker listening" with the list of queues it serves. Warnings at startup say what's disabled and why (no Twilio, no SMS sender, no email adapter yet).

## 3. Making a test call

Ring the demo number from your mobile. What should happen, and where to look:

1. **Twilio asks the API how to route the call.** API log: "Inbound call routed" with `route: agent`. If it says `voicemail`, the tenant isn't live or the agent hasn't synced.
2. **The agent answers.** First words are the disclosure. Try the personas in `docs/DEMO.md`.
3. **The call ends.** API log: "Voice call ended" with `outcome: stored`. If this line never appears, the webhook didn't reach the API (tunnel down?). The `reconcile-calls` job picks the call up within 15 minutes anyway.
4. **The worker extracts.** Worker log: "Call extracted" with the urgency. Then "Notification sent" with `channel: sms`. Email jobs wait in the queue until the email adapter exists.
5. **Your text arrives** within about a minute, with a link to the call page. Open it: JSON for now, with the transcript; `/recording` on the end plays the audio.

For an emergency persona (say "I can smell gas"): a priority text arrives while the call is still going, then the caller's phone gets the gas number by text (only if the caller's number is on the allowlist outside production), then the normal summary text.

## 4. Texting commands

Text the notification number from the demo tenant's registered mobile: `OFF`, `ON`, `HOLIDAY 12/12`, `STATUS`, `HELP`. The reply comes straight back. This needs a real mobile number as the sender; with an alphanumeric sender (`TWILIO_SMS_FROM=AnswerMate`) texts go out but replies can't come in.

## 5. When something's wrong

| Symptom                                                               | Likely cause                                                                                                    | Check                                                                                          |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Caller hears the fallback voicemail on every call                     | API unreachable from Twilio, or tenant not live, or agent not synced                                            | ngrok terminal; API log "Inbound call routed" reason; worker log for sync errors               |
| "Rejected voice webhook ... Invalid webhook signature" in the API log | Retell signs with the API key that carries the "webhook" badge in its dashboard, and `.env` has a different key | Put the badged key in `RETELL_WEBHOOK_KEY` (or use it as `RETELL_API_KEY`) and restart the API |
| "Rejected Twilio webhook" in the API log                              | `PUBLIC_BASE_URL` doesn't match the URL Twilio called                                                           | Compare the ngrok domain with `.env`, re-run `live-configure-number`                           |
| Call ended but no "Voice call ended" line                             | Retell couldn't reach the webhook                                                                               | Wait 15 minutes for reconciliation, or check the tunnel                                        |
| "SMS blocked by the outbound allowlist"                               | Your mobile isn't in `OUTBOUND_ALLOWLIST`                                                                       | Add it in E.164 (`+44...`) and restart the worker                                              |
| "notification-no-mobile" alert                                        | The tenant has no notification mobile                                                                           | Set it on the demo tenant                                                                      |
| Jobs piling up in `notify-email`                                      | Expected until the email adapter exists                                                                         | Nothing                                                                                        |
| `ALERT dead-letter` in the worker log                                 | A job failed every retry                                                                                        | The alert names the queue and job; the row's `sync_error` or the job's error says why          |
| Tests fail with "Couldn't migrate the test database"                  | Docker isn't running                                                                                            | `npm run db:up`                                                                                |

Logs never contain phone numbers, emails, transcripts or summaries: look things up by the IDs they carry.

## 6. Dashboard accounts

A new business signs up through a link: on the business list, "Create a signup link", then send it. It works once, for 14 days, and only you can tick "Test business" (allowed to go live while the legal documents are placeholders). Ant can make links too. Other accounts are invitations, made from the repo root:

```powershell
npm run invite-user -- --email <address> --role admin
npm run invite-user -- --email <address> --role reseller
npm run invite-user -- --email <address> --role owner --tenant <tenant id>
```

The person then logs in with that address (magic link, code or Google) and the login becomes
the account. A different address, or an address nobody invited, gets "No account for this
login". Step 11's onboarding will send the owner invitations itself.

To use the dashboard locally, start `npm run dev` and `npm run dev:web`, open
http://localhost:5173 and sign in. The API logs "Dashboard API on" at startup when
`CLERK_SECRET_KEY` and `ADMIN_DATABASE_URL` are set; otherwise it says what's missing. The
dashboard must stay on port 5173 (`DASHBOARD_ORIGIN`): Clerk's login tokens name the site they
were made for, and the API refuses tokens from any other.

## 7. Taking a business from signup to live

1. Create a signup link (business list) and send it. Their business appears at "Terms accepted".
2. On its Onboarding tab, tick "Pilot" while billing doesn't exist, and move it on.
3. Buy its number (Account tab, below), then move on.
4. Its owner fills in the Assistant tab; the worker syncs it; move on twice.
5. "Text the divert instructions" (Onboarding tab). Once the text goes, it moves on by itself.
6. The tradesperson dials the code and rings themselves from another phone. That call moves it to
   "Test call received", and it goes live by itself if the rule allows (until the solicitor's
   documents are in, only for a test business), with a "you're live" text. Otherwise the tab says
   why not.

The worker must be running for steps 5 and 6: it sends the texts and takes the business live.

## 8. Buying a number for a business

As admin, open the business, then its Account tab. With no number yet, there's a search: type an
area code such as 0113, pick a number, and confirm the monthly price. The API only buys when it
was started with `TWILIO_PURCHASES_ENABLED=true`, the same switch the `live-*` scripts use;
otherwise the page lets you look but not buy. Turn it back off afterwards. A business can't get a
second number this way: the old one would carry on costing money at Twilio. If a number is bought
but can't be recorded, the API raises a `number-bought-not-recorded` alert with its SID: record
it by hand or release it in the Twilio console.

## 9. Spending

Anything named `live-*` touches a paid service and asks for `--confirm`. Day to day the only money that moves is per call (Retell and Twilio per minute, Anthropic per extraction, Twilio per text segment). Evals (`npm run evals`) cost a few pence per run under their cap.
