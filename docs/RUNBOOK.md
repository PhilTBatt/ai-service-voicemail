# Runbook

How to run the system locally, make a test call, and read what happened. Written for Phil; production steps are added at Step 8.

## 1. Before the first call

Once, in this order:

| Step                          | Command or action                                                                                                                                                | Done when                                                                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Databases up and migrated     | `npm run db:up` then `npm run db:migrate`                                                                                                                        | `npm run db:status` shows nothing pending                                                                                             |
| Demo tenants seeded           | `npm run db:seed`                                                                                                                                                | No error; "Ant's Plumbing" exists                                                                                                     |
| `.env` filled in              | See `.env.example` for each name                                                                                                                                 | `npm run check` passes                                                                                                                |
| Tunnel running                | `ngrok http --domain=<your static domain> 3000` in its own terminal                                                                                              | `PUBLIC_BASE_URL` in `.env` matches it exactly                                                                                        |
| Fallback voicemail bins       | `npm run twiml:fallback` (bin 1), then `npm run twiml:fallback -- --done-url <bin 1 URL>` (bin 2)                                                                | Bin 2's URL is `FALLBACK_VOICEMAIL_URL`                                                                                               |
| Regulatory bundle approved    | Twilio console, Regulatory Compliance                                                                                                                            | `TWILIO_BUNDLE_SID` and `TWILIO_ADDRESS_SID` in `.env`                                                                                |
| Demo agent synced to Retell   | Start the worker (below), then `npm run demo:profile`                                                                                                            | The script prints "Synced" within a minute (or says why not); the worker logs "Agent synced"; the agent appears in Retell's dashboard |
| A number bought               | `npm run live-buy-test-number -- --search 0113`, then `--buy <number>`, then `--buy <number> --confirm` (with `TWILIO_PURCHASES_ENABLED=true` for that run only) | The script prints "Bought ... and assigned it to the demo tenant"                                                                     |
| Your mobile allowed for texts | `OUTBOUND_ALLOWLIST=+44...` in `.env`, and the demo tenant's notification mobile set to it (ask Claude for the one-line update)                                  | A test call texts you                                                                                                                 |

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

Text the notification number from the demo tenant's registered mobile: `OFF`, `ON`, `HOLIDAY 12/12`, `STATUS`, `HELP`. The reply comes straight back. This needs a real mobile number as the sender; with an alphanumeric sender (`TWILIO_SMS_FROM=AnswerMate`) texts go out but replies can't come in. A mobile registered on two businesses (one tradesperson, two trades) commands both, and the reply names each business's answer.

**Changing the mobile a business's texts go to** (its Account page): the new mobile is texted a 6-digit code (one segment, about 4p) and the texts switch to it only once the code is typed back. A code lasts 10 minutes and 5 tries; a business can ask for 3 codes an hour. Until then the old mobile keeps getting the texts. Clearing the mobile needs no code, and a change you make as admin is saved at once (you're setting the business up, not proving a phone is yours). The account log records `mobile.code-sent` and `notifications.changed`, never the number. Outside production the code goes only to a mobile on `OUTBOUND_ALLOWLIST`; the page says when it was blocked.

## 5. When something's wrong

| Symptom                                                                                               | Likely cause                                                                                                    | Check                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Caller hears the fallback voicemail on every call                                                     | API unreachable from Twilio, or tenant not live, or agent not synced                                            | ngrok terminal; API log "Inbound call routed" reason; worker log for sync errors                                                       |
| Caller hears the voicemail greeting a few seconds into a call                                         | The voice platform answered, then dropped the call                                                              | API log "Agent leg ended early" with the call SID and `seconds`; the platform's own call log for that call                             |
| One call hears the voicemail greeting, with "Restarting 'src/server.ts'" in the API log just after it | The call arrived while `npm run dev` restarted the API after a file change                                      | Don't edit code mid-call; the message is still stored and texted. Only the API's own `src` and `packages/shared/src` trigger a restart |
| "Rejected voice webhook ... Invalid webhook signature" in the API log                                 | Retell signs with the API key that carries the "webhook" badge in its dashboard, and `.env` has a different key | Put the badged key in `RETELL_WEBHOOK_KEY` (or use it as `RETELL_API_KEY`) and restart the API                                         |
| "Rejected Twilio webhook" in the API log                                                              | `PUBLIC_BASE_URL` doesn't match the URL Twilio called                                                           | Compare the ngrok domain with `.env`, re-run `live-configure-number`                                                                   |
| Call ended but no "Voice call ended" line                                                             | Retell couldn't reach the webhook                                                                               | Wait 15 minutes for reconciliation, or check the tunnel                                                                                |
| "SMS blocked by the outbound allowlist"                                                               | Your mobile isn't in `OUTBOUND_ALLOWLIST`                                                                       | Add it in E.164 (`+44...`) and restart the worker                                                                                      |
| "notification-no-mobile" alert                                                                        | The tenant has no notification mobile                                                                           | Set it on the demo tenant                                                                                                              |
| `ALERT job-dead-lettered` in the worker log                                                           | A job failed every retry                                                                                        | Section 11                                                                                                                             |
| Admin page: "No worker has checked in" or "hasn't checked in since"                                   | The worker isn't running (locally: only `npm run dev` was started)                                              | Start `npm run worker`; `GET /healthz/worker` says `running` within 30 s, and the waiting syncs go through                             |
| `npm run demo:profile` says "Not synced"                                                              | No worker, or the sync failed                                                                                   | The script names which; the worker log says "Agent synced" or the error                                                                |
| Tests fail with "Couldn't migrate the test database"                                                  | Docker isn't running                                                                                            | `npm run db:up`                                                                                                                        |

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

### When a legal document changes

The solicitor's documents replacing the placeholders, or any later change:

1. Put the full text where it can be read, and set its `url` in `packages/shared/src/signup.ts`.
2. Give it a **new** `version` there (never reuse one), and set `approved: true` for the solicitor's text. A version with "placeholder" in it never counts as approved.
3. Deploy. Every business is then asked on its dashboard to read and accept it (Account page, "Documents"), and only its owner can. Until it does, a business still onboarding can't go live; its page tells an admin which documents are outstanding.
4. A live business keeps its service in the meantime (open question 6 in `docs/PROGRESS.md`).

### Step by step

1. Create a signup link (business list) and send it. Their business appears at "Terms accepted".
2. On its Onboarding tab, tick "Pilot" while billing doesn't exist, and move it on.
3. Buy its number (Account page, below), then move on.
4. Its owner fills in the Assistant tab; the worker syncs it; move on twice.
5. "Text the divert instructions" (Onboarding tab). Once the text goes, it moves on by itself.
6. The tradesperson dials the code and rings themselves from another phone. That call moves it to
   "Test call received", and it goes live by itself if the rule allows (until the solicitor's
   documents are in, only for a test business), with a "you're live" text. Otherwise the tab says
   why not.

The worker must be running for steps 5 and 6: it sends the texts and takes the business live.

## 8. Buying a number for a business

As admin, open the business, then its Account page. With no number yet, there's a search: type an
area code such as 0113, pick a number, and confirm the monthly price. The API only buys when it
was started with `TWILIO_PURCHASES_ENABLED=true`, the same switch the `live-*` scripts use;
otherwise the page lets you look but not buy. Turn it back off afterwards. A UK number also needs the approved bundle and address: without `twilio-bundle-sid` and `twilio-address-sid` (section 16) the page refuses before asking Twilio, rather than letting Twilio refuse it. If Twilio does say no (the number went to someone else since the search, say), the page shows Twilio's reason. A business that has left can't be given one: it would pay for a number playing "service has ended" that could never be released. A business can't get a
second number this way: the old one would carry on costing money at Twilio. If a number is bought
but can't be recorded, the API raises a `number-bought-not-recorded` alert with its SID: record
it by hand or release it in the Twilio console.

## 9. When a business leaves

The tradesperson cancels on their Account page (or you do, from theirs), from any status but leaving already: one that never went live (a drop-out, a test business) and one you suspended can leave too, and go through the same release and deletion. From then on callers to
their number hear that the service has ended, and they get a text and an email with the codes
to turn their diverts off and get their voicemail back. The business appears on the Admin
section's Leaving page. After 30 days the "Release number" button appears: it gives the
number back to Twilio for good and marks the business cancelled.

**Changed their mind?** Until the number is released, the business's Account page (as admin) has **Undo cancellation**: it goes back to the status it left from (answering, paused, suspended or still onboarding), and the undo is in the account log. The cancellation text and email have already gone, so tell them it's back on. Once the number is released, it can't be undone: they'd sign up again.

The business then stays on that list as "number released, data still held", with a **Delete
data** button. It's charged for the month it left in (section 17), and deleting cancels its
Direct Debit, so the button refuses, saying why, until that last month has ended, been charged,
and been collected: usually a few days after the month ends. Type the business's name when
asked, and the worker deletes, in this order:

1. At Retell: each call's data, then the business's conversation flow and its agent.
2. At Twilio: the voicemail recordings, the call records for each number the business held
   (from when it was bought until it was released), and every text we sent about it.
3. At Clerk: the logins of the people whose only business this was.
4. At GoCardless: the Direct Debit is cancelled, so nothing more can be taken.
5. The written confirmation: by email, or by text if the email can't go (outside production,
   only to addresses on `OUTBOUND_ALLOWLIST`).
6. Here: calls, messages, the assistant's settings, contact details and those people's
   accounts. The billing record (each month's charge, the Direct Debit's history, which hold
   no personal details), the terms the business accepted and the account log stay. The
   billing record goes too, 7 years after the end of each month it covers: the nightly
   retention run (03:30) deletes every business's billing records that old, left or not.

The worker needs `ADMIN_DATABASE_URL`, the Twilio settings, `CLERK_SECRET_KEY`, and
`GOCARDLESS_ACCESS_TOKEN` if the business has a Direct Debit, for this.
A step that fails is retried; after the last retry the job goes to the dead-letter queue, which
alerts you. If the confirmation can't go by email or text, the deletion still happens and you
get a `deletion-confirmation-not-sent` alert naming the business: confirm it to them another
way.

What it can't reach: Twilio call records older than 13 months (only Twilio's Bulk Export deletes
those); the texts a tradesperson sends to control their account (STATUS, PAUSE and so on) and
our automatic replies, which we don't keep Twilio's references for; copies in Twilio's backups
(texts for up to 30 days); and the copies of sent emails Postmark keeps for 45 days.

## 10. Spending

Anything named `live-*` touches a paid service and asks for `--confirm`. Day to day the only money that moves is per call (Retell and Twilio per minute, Anthropic per extraction, Twilio per text segment). Evals (`npm run evals`) cost a few pence per run under their cap.

**Where the money goes: Admin, Usage and costs.** Every supplier with its plan, tiers, the last 30 days' cost and where the next 30 are heading, and a warning when that would cross a limit or fit a cheaper plan. All of it is an estimate from our own records and each supplier's published prices (dated in `apps/api/src/core/service-costs.ts`): the supplier's own bill is the truth. When you change a plan at a supplier (Postmark's, the database's size), change it in `CURRENT_PLANS` in that file too, or the page keeps warning about the old one. When a supplier changes its prices, the constants beside it. The **From your accounts** card reads Twilio's and Postmark's own figures as the page opens and uses them in place of the estimates; if one says it couldn't be read, the page falls back to estimates, and a 401 there means that key has been changed or revoked.

## 11. Alerts

An alert is an error line in the API's or the worker's log that starts `ALERT` and names it,
with IDs to look things up by. Logs never hold phone numbers, emails or call content. With
`ALERT_EMAIL` set (Key Vault `alert-email`, in `OPTIONAL_SECRET_NAMES`), each one is also
emailed there, with the same redacted details: at most one email per alert per 15 minutes,
the next one saying how many it stood in for. Alerts about one business needing something done (billing, delivery, bounces, a deletion's confirmation) are counted per business, so two businesses in the same 15 minutes each get an email; outage-type alerts stay one email however many businesses they touch. Outside production the address must be in
`OUTBOUND_ALLOWLIST`. Each alert waits in the database (`alert_outbox`) until an email has carried it: if Postmark is down, the API and the worker try again after 1 minute, then 2, 4, 8 and every 15, and a restart or a release in between loses nothing (each process looks for waiting alerts as it starts, then every minute). Alerts held back by the 15 minutes get their own email when the 15 minutes are up. Only if the database itself can't be reached does an alert wait in that process's memory, as they all did before 2026-11-13. The log line is there whatever happens.
What the service can't email about is itself being down: that's the uptime check's job.

| Alert                                             | What it means                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | First three checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `job-dead-lettered`                               | A background job failed every retry and has stopped. The alert carries the job's data: which business and call                                                                                                                                                                                                                                                                                                                                                                                                                                         | 1. The worker log just before it, for the job's own error (same IDs). 2. Whether a provider was down, or a setting is missing from `.env`. 3. Once that's fixed, redo what made the job (save the profile again, say), or ask me                                                                                                                                                                                                                                                                                                              |
| `voice-platform-unreachable`                      | A call came in and Retell wouldn't take it, so the caller got the fallback voicemail                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 1. The API log line before it, for Retell's answer (401: the key; 404: the agent). 2. Retell's dashboard: is the business's agent there? 3. If every call does it, whether Retell has an outage; meanwhile the kill switch (section 13) sends every caller to voicemail on purpose                                                                                                                                                                                                                                                            |
| `agent-sync-failed`                               | A saved assistant profile couldn't be sent to Retell. The job retries, and the last synced agent keeps answering (a new business gets voicemail until its first sync)                                                                                                                                                                                                                                                                                                                                                                                  | 1. The Admin page's failing syncs, with Retell's error. 2. An outage (it retries by itself) or a validation error. 3. If validation, fix the profile and save it again                                                                                                                                                                                                                                                                                                                                                                        |
| `call-extraction-failed`                          | The AI couldn't summarise a call: its answer didn't fit, it refused, Anthropic refused the request outright (a revoked key, no credit, a retired model), or Anthropic was unreachable for three minutes after the call ended. The tradesperson still got the text and email, saying the summary isn't available and to read the transcript; an emergency's texts went before the AI was asked at all. A burst of these during an outage means Anthropic is down; the calls are safe                                                                    | 1. The worker log before it, for Anthropic's error (key, credit, outage). 2. Credit and keys in the Claude Console. 3. The call in the dashboard: an empty or unusual transcript?                                                                                                                                                                                                                                                                                                                                                             |
| `summary-judge-failed`                            | The sampled quality check (`JUDGE_SAMPLE_RATE`) found a summary that doesn't match its call                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 1. Read the call: summary against transcript. 2. If it misled, tell the tradesperson. 3. Keep the case for the evals (`npm run evals`)                                                                                                                                                                                                                                                                                                                                                                                                        |
| `guardrail-hit`                                   | The transcript shows the agent saying something it mustn't: a price, a promised time, or safety advice beyond the scripts                                                                                                                                                                                                                                                                                                                                                                                                                              | 1. Read the transcript at the rule named. 2. Check the business's profile for wording that invited it. 3. Tell the tradesperson if the caller was told something wrong, and keep the case for the evals. 4. Mark it reviewed on the Admin page, which takes it out of the queue                                                                                                                                                                                                                                                               |
| `notification-no-mobile`, `notification-no-email` | A call's text or email couldn't go: the business has no mobile or email set. (A send the provider refused is a different thing: it retries, then dead-letters, and the Admin page's health section lists it with the provider's reason)                                                                                                                                                                                                                                                                                                                | 1. The business's Account page. 2. Ask the tradesperson for it. 3. Tell them about the calls since: those messages aren't resent                                                                                                                                                                                                                                                                                                                                                                                                              |
| `notification-refused`                            | The provider turned a text or email down for good (a 4xx answer: an invalid number, an unknown or inactive address, a Postmark account that may not send there yet), so the job stopped rather than retrying. The alert carries the provider's reason                                                                                                                                                                                                                                                                                                  | 1. The reason in the alert, or on the Admin page under "Texts and emails that couldn't be sent". 2. The business's Account page, if it's the number or address. 3. Once it's fixed, the message isn't resent: tell the tradesperson about the call                                                                                                                                                                                                                                                                                            |
| `sms-undelivered`                                 | Twilio says a text didn't reach the phone. The alert has Twilio's error code, and `callId` for a call's text or `messageKind` for the business's other texts (`onboarding text: divert instructions`, `onboarding text: go live`, `cancellation text`, `deletion confirmation text`). With `messageKind` it's counted per business, as it's about that business alone                                                                                                                                                                                  | 1. The code in Twilio's error list (twilio.com/docs/api/errors). 2. The mobile on the Account page. 3. Whether the phone is on, or its network has trouble. An undelivered onboarding text isn't sent again by itself: once it's sorted, "Text the divert instructions" again (Onboarding tab); the go-live text goes only once, so phone them. A deletion confirmation text: as `deletion-confirmation-not-sent`                                                                                                                             |
| `recipient-opted-out`                             | The tradesperson's phone replied STOP to our number, so texts to it fail (Twilio error 21610). `callId` or `messageKind` says which text found out, as for `sms-undelivered`                                                                                                                                                                                                                                                                                                                                                                           | 1. Ask them to text START to the same number. 2. Email still reaches them meanwhile. 3. Check it's the right mobile                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `email-bounced`, `email-spam-complaint`           | Postmark couldn't deliver one of our emails, or the person marked it as spam: a call's summary (`callId`), or the business's other emails (`messageKind`: `billing email: receipt`, `billing email: payment failed`, `billing email: direct debit ended`, `cancellation email`, `deletion confirmation email`). If the alert says `addressDeactivated`, Postmark won't send to that address until it's reactivated, and the next email to it is refused (`notification-refused`)                                                                       | 1. The address on the Account page. 2. Postmark's activity for the message, and the reason. 3. Once it's fixed, reactivate the address in Postmark. A billing email isn't sent again by itself: tell them what it said (a failed payment matters most). A deletion confirmation: the business's details are gone by then, so as `deletion-confirmation-not-sent`, from your own records                                                                                                                                                       |
| `number-bought-not-recorded`                      | A number was bought at Twilio but couldn't be saved here: it's costing money and isn't attached to the business                                                                                                                                                                                                                                                                                                                                                                                                                                        | 1. Twilio's console, Phone Numbers: the SID in the alert. 2. The API log for the database error. 3. Ask me to attach it, or release it in Twilio's console                                                                                                                                                                                                                                                                                                                                                                                    |
| `deletion-confirmation-not-sent`                  | A business's data was deleted, but neither email nor text could carry the written confirmation                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 1. The business named in the alert. 2. Your own records for how to reach them. 3. Confirm the deletion to them in writing another way, and keep a copy                                                                                                                                                                                                                                                                                                                                                                                        |
| `recording-not-deleted`                           | A call's recording is past its 30 days and couldn't be deleted. `reason: no-recording-id`: a fallback voicemail whose stored reference has no Twilio recording ID, so no retry can work. `provider-failed`: Retell or Twilio failed the deletion three nights running. Said once per recording. The nightly run keeps trying, recordings it has never failed on first, so a stuck one never holds up the rest                                                                                                                                          | 1. The worker log's "Recording deletion failed" lines for the `callId`, with the provider's error. 2. `no-recording-id`: find the recording in Twilio's console (Call recordings, by the call's time), delete it there, then the call's `recording_ref` needs clearing (ask me: it needs the admin login). 3. `provider-failed`: the provider's status page; once it's back, the next night's run deletes it                                                                                                                                  |
| `payment-mandate-ended`                           | A business's Direct Debit was cancelled (by them, at their bank) or failed (the provider's reason is in the alert, e.g. `bank_account_closed`), so nothing more can be collected from it. Its service carries on: nothing is switched off automatically                                                                                                                                                                                                                                                                                                | 1. The business's Account page, which shows it ended and why. 2. Contact them: they set it up again from the same tab. 3. If they don't, suspending is your call (the Admin page), never automatic                                                                                                                                                                                                                                                                                                                                            |
| `billing-no-mandate`                              | A month ended and is owed, but the business has no Direct Debit to collect from. It's tried again every morning, and collected as soon as one is set up. Said once per month owed                                                                                                                                                                                                                                                                                                                                                                      | 1. The business's Account page: no Direct Debit, or one that ended. 2. Ask them to set it up from the same tab. 3. A pilot past its free month needs one too                                                                                                                                                                                                                                                                                                                                                                                  |
| `billing-payment-failed`                          | A month's payment couldn't be collected: the bank failed it, it was cancelled, or it was reversed (`status` and `reason` say which). The business has been emailed. Nothing is switched off. (A request GoCardless refuses outright, such as a wrong access token, isn't this: the morning run fails and retries, then `job-dead-lettered`)                                                                                                                                                                                                            | 1. The reason (`insufficient_funds`, `refund_requested`...) and the payment in the GoCardless dashboard. 2. Contact the business. 3. Collect it again from the Admin page (Billing, **Collect again**: GoCardless retries the same payment, up to three times, while the Direct Debit is active); suspending is your call, from the business's Account page                                                                                                                                                                                   |
| `fallback-voicemail-spike`                        | More than 2 callers in 15 minutes got the fallback voicemail, for any reason: Retell down or slow, agents not synced, or businesses paused. Once per burst, per API copy                                                                                                                                                                                                                                                                                                                                                                               | 1. The API log just before: `voice-platform-unreachable` means Retell; "ran out of time" means something slow; otherwise the routing reason. 2. Retell's status page. 3. If Retell is down and stays down, the kill switch (section 13) is the honest version of the same thing                                                                                                                                                                                                                                                               |
| `webhook-signature-spike`                         | More than 10 webhooks in 15 minutes had a bad signature (`source` says Twilio or the voice platform). Someone is probing, or a key changed on one side only                                                                                                                                                                                                                                                                                                                                                                                            | 1. Whether the auth token or webhook key was rotated (section 14) without the other side. 2. The log lines' paths: real routes or random ones (a scanner)? 3. If it's one address hammering, Azure's ingress can block it; otherwise nothing to do, forgeries are refused                                                                                                                                                                                                                                                                     |
| `server-error-spike`                              | More than 5 requests in 15 minutes ended in a 500. The alert names the last path                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 1. The API log's "Unhandled request error" lines, for the error itself. 2. `/readyz` (the database) and the worker's check-in on the Admin page. 3. If it started with a release, release the previous commit                                                                                                                                                                                                                                                                                                                                 |
| `scheduled-job-overdue`                           | A recurring job hasn't succeeded for longer than it should (`jobs` lists each one that just went overdue: the two every-15-minutes checks get an hour, retention and billing 26 hours). `runsHere: false` means the worker doesn't run it at all: a setting it needs is missing. The worker checks every 10 minutes and says it once per stoppage, and again after each restart (a deploy) while it's still overdue. A job turned off on purpose keeps its row and so keeps saying it at each restart: deleting the row needs the owner login (ask me) | 1. The Admin page's Scheduled jobs: last ran, and last failed. 2. `runsHere: false`: the worker's start-up log says what's missing ("Charging disabled: needs ..."): put the setting back (Key Vault, `OPTIONAL_SECRET_NAMES`) and **Deploy**, `apply`. 3. Failing: the worker log around the last failure, and `job-dead-lettered`. (A worker down alone over 03:30 or 06:00 loses nothing: the API queues the run and the worker takes it when it's back. If both, or the database, were down then, the run is sent once when they're back) |
| `voicemail-transcription-failed`                  | Twilio couldn't transcribe a voicemail (section 18): the tradesperson has the plain "new voicemail" text and email with the recording, and nothing more for that call. The alert carries Twilio's reason, never the words. Said once per voicemail; it isn't retried                                                                                                                                                                                                                                                                                   | 1. The reason: a recording Twilio says is too short or missing is nothing to fix. 2. Several in a row: the Admin page's "Asked for" figures (how many failed against how many done), then Twilio's status page. 3. If it keeps happening, turn the switch off (Admin, Overview) until it's understood: every attempt costs money                                                                                                                                                                                                              |
| `voice-webhook-unreadable`                        | Retell sent a correctly signed call-ended webhook (`source: webhook`), or reconciliation fetched calls (`source: reconciliation`, with a count), in a shape the API can't read: those calls aren't stored, so no texts went for them. Most likely Retell changed its format. `fields` names what didn't fit                                                                                                                                                                                                                                            | 1. Retell's changelog and API reference for the call object. 2. The fields named in the alert against `callSchema` in `providers/retell.ts`. 3. Once the code reads the new shape and is released, reconciliation stores the last day's calls by itself; older ones are in Retell's dashboard                                                                                                                                                                                                                                                 |

## 12. Pausing a business

Paused, a business's callers get the fallback voicemail: no AI, but still recorded, and still
texted to the tradesperson.

- **From the dashboard:** the business's page has an on/off switch. The tradesperson can use it,
  and so can you as admin. It works for a business that's live or paused.
- **By text:** the tradesperson texts `OFF` or `PAUSE` from their registered mobile to the
  AnswerMate number, and `ON` or `RESUME` to switch back (section 4).

## 13. The kill switch

For when the AI itself is the problem: it's saying something it mustn't, or Retell is down. On
the Admin page, turn on the kill switch: from the next call, every number for every business
goes straight to the fallback voicemail. Voicemails are still recorded and texted. Turning it on
or off is audited. Turn it off on the same page; nothing needs restarting.

## 14. Rotating a secret

The order is always the same: make the new one, put it where the app reads it, restart, check
it works, then delete the old one. In development the settings live in `.env`, which you edit.
In production they'll live in Azure Key Vault (Step 8). The API and the worker read them when
they start, so restart both.

| Setting                                | How                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TWILIO_AUTH_TOKEN`                    | Twilio lets an account have a secondary auth token. Create one, then promote it to primary, which deletes the old primary (Twilio's docs). Each change emails the account's owners. Put the new token in `.env` and restart straight after promoting. I believe Twilio signs its webhooks with the primary token: if so, they fail our check until the restart, and callers in that minute get the fallback voicemail. Do it at a quiet time |
| `RETELL_API_KEY`, `RETELL_WEBHOOK_KEY` | Retell allows several keys. Add one, and for webhooks select it and "Set as Webhook Key" (one key at a time can be). Update `.env`, restart, then delete the old key. Webhooks signed with the new key fail until the restart; reconciliation picks up those calls within 15 minutes                                                                                                                                                         |
| `ANTHROPIC_API_KEY`                    | Claude Console, API keys, Create key. A key's expiry is set when it's made and can't be changed later. Update `.env`, restart the worker, then disable the old key (that can be undone), and delete it when you're sure                                                                                                                                                                                                                      |
| `POSTMARK_SERVER_TOKEN`                | A Postmark server can have up to 3 API tokens at once (its API Tokens tab). Add one, update `.env`, restart the worker, then remove the old one                                                                                                                                                                                                                                                                                              |
| `CLERK_SECRET_KEY`                     | Clerk shows a secret key's full value only when it's added. Add one on the dashboard's API keys page and copy it then, update `.env`, restart the API and the worker, then delete the old one                                                                                                                                                                                                                                                |
| `SIGNING_SECRET` (ours)                | Signs the call links in texts and emails. Changing it stops every link already sent from working, so only change it if it has leaked. Make one with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`                                                                                                                                                                                                    |
| `POSTMARK_WEBHOOK_SECRET` (ours)       | The password on Postmark's bounce webhook. Change it in `.env` and in the webhook's settings at Postmark together                                                                                                                                                                                                                                                                                                                            |

## 15. Restoring from a backup

**Production** (Azure Database for PostgreSQL flexible server, decision 011). Azure backs it up
by itself and keeps the backups 7 days by default (up to 35). A restore never overwrites the
server: it makes a new one, as the old one was at the moment you choose, and you then point the
app at it.

1. In the Azure portal, open the server, Overview, Restore. Choose "Latest restore point (Now)"
   or a "Custom restore point" (in UTC), name the new server, then Review + create. Or with the
   Azure CLI: `az postgres flexible-server restore --resource-group <group> --name <new-server> --source-server <server> --restore-time 2026-11-07T02:10:00+00:00`.
2. Microsoft says it takes from a few minutes to a few hours. To find out for ours, and prove a
   backup really comes back: **Deploy**, `restore-drill`. It restores the live database to a
   scratch server, times it, checks the copy (the businesses, the calls, the newest migration,
   the three logins), and deletes the scratch server, all in one run (a few pence: about 2p an
   hour for the server, by the database's £14 a month). The live server isn't touched. The run's
   summary says how long it took: record it here.
3. Firewall and network rules and server parameters don't come across: set them again on the
   new server, and check our roles (`callmate_app`, `callmate_admin`) can log in.
4. Point `DATABASE_URL` and `ADMIN_DATABASE_URL` (in Key Vault) at the new server, restart the
   API and the worker, and check `/readyz` answers.
5. Keep the old server until you're sure, then delete it: it's charged until you do.

**Development** (your PC). The dev data lives in a Docker volume, with no backup unless you
make one. From the repo root:

```powershell
docker compose exec -T db pg_dump -U callmate -d callmate -Fc -f /tmp/dev.dump
docker compose cp db:/tmp/dev.dump .\dev.dump
```

To put it back, stop the API and the worker first (the database is dropped and made again):

```powershell
docker compose cp .\dev.dump db:/tmp/dev.dump
docker compose exec -T db pg_restore -U callmate -d postgres --clean --create /tmp/dev.dump
```

A backup holds call content: git ignores `*.dump` files, and don't share one.

## 16. Deploying to Azure (Step 8)

Everything goes through GitHub: repo, **Actions**, **Deploy**, **Run workflow**, then pick a step. The Azure steps wait for your approval (the `production` environment's required reviewer), and sign in with OIDC, so no Azure password is stored anywhere.

| Step                     | What it does                                                                                    | Costs money?                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `image`                  | Builds the image and publishes it to GitHub's registry                                          | No                                                                    |
| `infrastructure-what-if` | Shows what `infra/main.bicep` would create or change in `rg-callmate-prod`, and changes nothing | No                                                                    |
| `infrastructure-apply`   | Creates or updates it                                                                           | Yes, from the first run: the database is about £14 a month on its own |

Before the first infrastructure run, once:

1. **Resource providers.** A new subscription may not have them, and the deploy identity can't add them (it only has rights on the resource group). Azure portal, **Subscriptions**, your subscription, **Settings**, **Resource providers**: register `Microsoft.App`, `Microsoft.DBforPostgreSQL`, `Microsoft.OperationalInsights`, `Microsoft.KeyVault` and `Microsoft.ManagedIdentity`.
2. **The `production` environment** (GitHub, Settings, Environments), besides its three Azure IDs:
   - secret `POSTGRES_ADMIN_PASSWORD`: a long random password from a password manager; keep a copy there too. The password only: the whole `postgres://...` address goes in Key Vault's `postgres-admin-url`, not here (the first `database-setup` runs failed on exactly that mix-up).
   - variable `KEY_VAULT_ADMIN_OBJECT_ID`: your own **Object ID** (Entra admin center, **Users**, you, **Overview**). It lets you add the secrets to Key Vault.

After `infrastructure-apply`, the run's log ends with the Key Vault's name and the database's address: the next step's secrets go there.

### The secrets the apps read (Key Vault `kv-callmate-dalbkqkh`)

Azure portal, **Key vaults**, `kv-callmate-dalbkqkh`, **Objects**, **Secrets**, **Generate/Import**. Each Key Vault name is the setting's name in lower case with hyphens: `database-url` is `DATABASE_URL`. The apps can't start until every required one is there.

**The four database URLs.** Make three new passwords first, one per login, **letters and digits only**, at least 24 characters (no symbols, so they're safe inside a URL). The host is `psql-callmate-dalbkqkh.postgres.database.azure.com`.

| Key Vault name           | Value                                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres-admin-url`     | `postgres://callmateadmin:<POSTGRES_ADMIN_PASSWORD>@<host>:5432/callmate?sslmode=require` (if that password has symbols, URL-encode them) |
| `migration-database-url` | `postgres://callmate_owner:<password 1>@<host>:5432/callmate?sslmode=require`                                                             |
| `database-url`           | `postgres://callmate_app:<password 2>@<host>:5432/callmate?sslmode=require`                                                               |
| `admin-database-url`     | `postgres://callmate_admin:<password 3>@<host>:5432/callmate?sslmode=require`                                                             |

**The admin password belongs to the GitHub secret.** `infra/main.bicep` passes `POSTGRES_ADMIN_PASSWORD` as the server's `callmateadmin` password on every deploy, so treat GitHub's copy as the real one: to change it, update the GitHub secret and add a new version of `postgres-admin-url` with the same password, then deploy. (Microsoft's docs don't say whether a redeploy re-applies the password to an existing server, so don't rely on a deploy to undo or apply a portal reset.) If `database-setup` fails with `password authentication failed for user "callmateadmin"`, compare the two fingerprints in its Actions log: the workflow prints GitHub's, the job prints Key Vault's. Different: set both from one copy. Same: the server has a third password; reset it in the portal (the server's **Overview**, **Reset password**) to that same one and run `database-setup` again. A failed job's output is printed in the Actions log, under the error.

**The rest, copied from your `.env`** (same values, or the live ones):

`retell-api-key`, `twilio-account-sid`, `twilio-auth-token`, `fallback-voicemail-url`, `anthropic-api-key`, `twilio-sms-from`, `signing-secret`, `postmark-server-token`, `email-from`, `clerk-secret-key`.

**`postmark-webhook-secret`** isn't in `.env` until Postmark's bounce webhook is set up: make one up (`node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))"`), and keep a copy to paste into Postmark's webhook URL later (section 14).

**Two that matter more than "optional" suggests.** `retell-webhook-key`: Retell signs its webhooks with the one key marked "webhook" in its dashboard; without this, the API checks them with `retell-api-key`, which works only if that same key has the badge, and otherwise every call-ended webhook is refused (calls then arrive up to 15 minutes late, through reconciliation). The API's log says so at start-up when it isn't set. `twilio-bundle-sid` and `twilio-address-sid`: a UK number can't be bought without them (section 8), and buying from the dashboard also needs `twilio-purchases-enabled` = `true` (then back to `false`).

**Optional ones** (only if you use them): `alert-email` (where alerts are emailed, section 11), `gocardless-access-token`, `gocardless-environment` (`live`, once there's a live GoCardless account; the sandbox otherwise) and `gocardless-webhook-secret` (billing, decision 019), `vat-registration-number`, `vat-registration-from`, `vat-seller-name` and `vat-seller-address` (once VAT registered, section 17), `retell-webhook-key`, `clerk-jwt-key`, `twilio-bundle-sid`, `twilio-address-sid`, `email-reply-to`. Add each one you use to the `production` environment variable `OPTIONAL_SECRET_NAMES` as a JSON list, for example `["retell-webhook-key"]`, so the apps read it.

### The first release, in order

1. All the secrets above in Key Vault.
2. **Deploy**, `database-setup`: builds the image, then creates the three database logins with those passwords. Once only (running it again just sets the passwords again).
3. **Deploy**, `release`: builds the image, runs the migrations, starts the API and the worker, and checks the API answers. The log ends with its address: `https://callmate-api.greengrass-a4449d88.uksouth.azurecontainerapps.io`.

After that, every release is just step 3.

### When a release fails

Deploy changes production only from `main`: a run started from another branch fails at once (the `main-only` job says so) and changes nothing. Merge, then run it from `main`.

- **"Run the migrations" fails with `canceling statement due to lock timeout`.** A migration waited more than 5 seconds for a lock on a table something else was holding (a long query, a stuck transaction). It gave up rather than hold up calls (the owner role's `lock_timeout`, migration `20261111170000`), and the apps weren't moved to the new image, so nothing changed for callers. Run `release` again in a few minutes. If it fails the same way twice, something is holding the lock for good: ask me to find it with you (`pg_stat_activity`).
- **"Check the new API and worker are running" fails.** The log's last two lines show what `/readyz` and `/healthz/worker` said. `/readyz` reports the build answering (`version`) and `"starting"` while it's still connecting to the job queue; `/healthz/worker` reports the build that last checked in. Old build still answering after 5 minutes: the new revision didn't become ready, so look at the API's logs in the Azure portal (Container App `callmate-api`, Log stream). API right but the worker on the old build, or `"down"`: the same for `callmate-worker`. Callers are safe either way: Azure keeps traffic on the old API until the new one is ready, and a worker that's down only delays texts and summaries (they're queued).
- **The database was down while the API or worker started.** Neither crashes any more: both wait for it and carry on by themselves. The API answers `/readyz` with `"starting"` until then, and Twilio's fallback URL takes calls meanwhile.

**After every release** (decision 021): about two minutes after the new worker starts, its log says "Agents queued for a re-check against this build". Each agent whose prompt, scripts or webhook address changed with the release is sent again ("Agent re-synced"); the rest are left alone. A migration never takes anything away in the same release that stops using it, because the old build is still answering calls while it runs: `npm run check` refuses a migration that drops, renames, changes a type or makes a column required, unless the statement says `-- release-safe:` and why.

### Running a script against production (the `task` step)

**Deploy**, `task`, with the script's name and arguments in the **command** box, for example `invite-user --email you@example.com --role admin`. It runs that script from `apps/api/src/scripts` in the `callmate-task` job, which has the apps' image and every setting they have, and prints the script's output in the Actions log. The job is created by a release, so the first `task` needs a release before it. Whatever is typed in the box is visible in this public repository's run log, so a script that needs contact details reads them from Key Vault instead: add the optional secrets `demo-mobile` and `demo-email` and list them in `OPTIONAL_SECRET_NAMES` before the demo business step below. A script opens database connections of its own, up to 8 (`create-demo-business`), on top of the apps' 17: 25 of the database's 35. A release already reaches 35 at its peak, so `task` waits for any release to finish (they share one queue in the workflow) and a release waits for a task. Don't start the `callmate-task` job by hand from the Azure portal while a release is running.

### The demo business in production, in order

The live database starts empty: no businesses, no logins. The demo line (the number Ant and prospects call) is the seed's first business, "Ant's Plumbing", with the same fixed ID as on a laptop, so every script that knows the demo business finds it.

1. Key Vault: `demo-mobile` (where the demo line's texts go, `+44...`) and `demo-email`; add both to `OPTIONAL_SECRET_NAMES` (`["alert-email","demo-mobile","demo-email"]`, say) and **Deploy**, `release`, so the apps and the task job read them.
2. **Deploy**, `task`: `invite-user --email <your login email> --role admin`. Your first login to the live dashboard then claims it.
3. **Deploy**, `task`: `create-demo-business --number +44... --sid PN...`, the demo line's number and its SID from Twilio's console (Phone Numbers, the number, its SID). It creates the business, records the number and saves the agent profile; the worker syncs the profile to Retell (a new agent there, separate from the laptop's).
4. **Deploy**, `task`: `live-configure-number --confirm`. Points the number at the live API, so calls stop going to the laptop. The number's fallback stays the TwiML Bin voicemail.
5. Call the number. The call shows on the live dashboard; the text and the email arrive at `demo-mobile` and `demo-email`.

To hand the number back to a laptop for a day, run `npm run live-configure-number -- --confirm` locally (with ngrok up); step 4 takes it back.

### Changing the fallback voicemail's words

The voicemail callers hear when the assistant can't answer comes from two places. A paused or suspended business and the kill switch get the API's copy, which changes with a release. When the API itself is down, Twilio plays the TwiML Bin (bin 2), which only changes when you paste a new copy into it. So after a release that changes the greeting (`FALLBACK_VOICEMAIL_GREETING` in `apps/api/src/core/scripts.ts`), update the bin too:

1. Twilio console, **TwiML Bins**: open bin 1 ("AnswerMate voicemail done") and copy its URL.
2. From the repo root: `npm run twiml:fallback -- --done-url <bin 1's URL> --base-url https://callmate-api.greengrass-a4449d88.uksouth.azurecontainerapps.io`. Use that address even after the domain move: the API answers at it for good (`ALTERNATE_BASE_URL`). Without `--base-url` the script uses your `.env`'s ngrok address, which would send production's voicemails to your laptop.
3. Open bin 2 ("AnswerMate fallback voicemail"), replace everything in it with what the script printed (from `<?xml` to `</Response>`), and save. Its URL doesn't change, so nothing else needs updating.
4. Check it: Twilio console, the demo number, **Voice configuration**: its fallback URL is still bin 2's URL.

### Moving to a newer Node image

The image is built on one exact Node image, pinned by version and digest at the top of the `Dockerfile` (`ARG NODE_IMAGE`), so every release builds on the same Node and Debian until you choose otherwise. To move on (a Node security release, say, or once a quarter):

1. Docker Hub's [node tags](https://hub.docker.com/_/node/tags?name=-slim): the newest `26.x.y-trixie-slim` (the Node major in `package.json`'s `engines`).
2. Its digest, from the repo root: `docker buildx imagetools inspect node:26.x.y-trixie-slim`. Copy the `Digest:` line (`sha256:...`) at the top, the multi-platform one, not one of the per-platform ones under it.
3. Put both in `ARG NODE_IMAGE=node:26.x.y-trixie-slim@sha256:...`, update the date and version in the comment above it, run `npm run check`, and release as usual.

`npm run check` refuses a `Dockerfile` whose image isn't pinned this way, or whose Node major isn't `engines`'.

### The uptime check (decision 018)

The one thing the service can't email about is being down, so something outside asks it every five minutes. UptimeRobot, free plan, two monitors of type HTTP(s), each alerting the same address as `ALERT_EMAIL`:

| Monitor | URL                                                                                     | Means, when it fails                                                    |
| ------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| API     | `https://callmate-api.greengrass-a4449d88.uksouth.azurecontainerapps.io/readyz`         | The API is down, or can't reach the database (section 5's first checks) |
| Worker  | `https://callmate-api.greengrass-a4449d88.uksouth.azurecontainerapps.io/healthz/worker` | The worker hasn't checked in for two minutes: no texts, emails or syncs |

When one fires: the Azure portal, the app (`callmate-api` or `callmate-worker`), **Log stream** for the live output, and **Revisions and replicas** for whether Azure could start it at all. A release that broke it is undone by releasing the previous commit.

### Postmark's bounce and spam-complaint webhook

Postmark pauses an account whose bounces pass 10% of the emails it sends, or whose spam complaints pass 1 in 1,000, holding its emails until it's sorted ([Postmark](https://postmarkapp.com/support/article/does-postmark-have-a-daily-send-limit); it doesn't say over what period, or from what volume). At our volume one bounce among a few dozen emails is several percent, and one complaint is far over, so each needs seeing. This webhook is how: a hard bounce or a complaint marks that email undelivered where it was sent from (its call, or the billing email, cancellation email or deletion confirmation) and raises `email-bounced` or `email-spam-complaint` (section 11).

1. **The password.** Key Vault `kv-callmate-dalbkqkh`, **Secrets**, `postmark-webhook-secret`, its current version, **Show Secret Value**: the one made up at set-up (it isn't in `.env`).
2. **The webhook.** Postmark, **Servers**, your server, its transactional message stream (Postmark calls it "Default Transactional Stream"), **Webhooks**, **Add webhook**. URL: `https://postmark:<the password>@callmate-api.greengrass-a4449d88.uksouth.azurecontainerapps.io/webhooks/postmark`. The password goes in the URL like that: Postmark has no separate boxes for it ([Postmark](https://postmarkapp.com/developer/webhooks/webhooks-overview)). Tick **Bounce** and **Spam Complaint**, click **Verify webhook** (Postmark sends each ticked event and wants a 200 back; the API answers 200 from 2026-11-13, 204 before, which Postmark counts as a failure), and save. It can stay on this address after the domain moves (step 4 below).
3. **After a bounce.** Postmark stops sending to an address after a hard bounce or a complaint. A hard bounce is usually a mistyped address: correct it on the business's Account page, then reactivate it in Postmark (the stream's **Suppressions**). Postmark's support has to reactivate an address that complained.
4. **Never test with made-up addresses from production**: they bounce, and count. Postmark's black-hole addresses don't (`HardBounce@bounce-testing.postmarkapp.com`, [Postmark](https://postmarkapp.com/support/article/1239-how-to-test-bounces)).

### The domain: app.brockersby.co.uk, and Clerk's production instance

The dashboard and the API move from Azure's generated address to `app.brockersby.co.uk`, with Azure's free certificate; then Clerk gets a production instance on the same domain. Three stages, each a Deploy `apply` (a few minutes, no rebuild), driven by two `production` environment variables: `CUSTOM_DOMAIN` (`app.brockersby.co.uk`) and `CUSTOM_DOMAIN_STAGE` (`add`, then `bind`, then `live`). Microsoft documents this for the portal and the CLI; the template does the same steps in the same order, so the first run through is the check.

0. **The latest code released first** (**Deploy**, `release`): the steps below use `apply`, which re-applies the image the apps already run, and that image needs the code that keeps calls working during the switch (`ALTERNATE_BASE_URL`, step 4).
1. **Variables.** GitHub, Settings, Environments, production: `CUSTOM_DOMAIN` = `app.brockersby.co.uk`, `CUSTOM_DOMAIN_STAGE` = `add`. **Deploy**, `apply`. Its log ends with the outputs; copy `customDomainVerificationId`.
2. **DNS at Porkbun** (brockersby.co.uk, DNS records), two records:
   - `CNAME`, host `app`, answer `callmate-api.greengrass-a4449d88.uksouth.azurecontainerapps.io`
   - `TXT`, host `asuid.app`, answer the `customDomainVerificationId` from step 1
     Porkbun's default TTL is fine. Wait a few minutes, then check from PowerShell: `Resolve-DnsName app.brockersby.co.uk -Type CNAME` should show the Azure address.
3. **Certificate.** `CUSTOM_DOMAIN_STAGE` = `bind`; **Deploy**, `apply`. Azure asks DigiCert for the certificate (several minutes; the run waits). Then `https://app.brockersby.co.uk/healthz` answers `{"status":"ok"}` with a valid padlock. The old address still works.
4. **Switch.** `CUSTOM_DOMAIN_STAGE` = `live`; **Deploy**, `apply`. The apps now call `https://app.brockersby.co.uk` their own address, and the generated one becomes `ALTERNATE_BASE_URL`. Then one task, because Twilio still has the old address: **Deploy**, `task`, `live-configure-number --confirm` (Twilio's webhooks). Retell's webhook address follows by itself: the apply restarts the worker with the new address, and about two minutes later it re-syncs every agent whose webhook address changed (decision 021; the worker's log says "Agent re-synced" for each). `save-demo-profile --wait 0` as a task does the same for the demo agent by hand, if it's ever needed. Calls carry on throughout: the API accepts Twilio's signatures for either address while `ALTERNATE_BASE_URL` is set, so there's no rush between the apply and the task. GoCardless's and Postmark's webhooks can stay on the old address: it keeps working, and their checks don't involve the address. So can the fallback TwiML Bin, whose voicemail recordings report to the old address: that works because `ALTERNATE_BASE_URL` stays set for as long as the stage is `live`. Should the old address ever be dropped, regenerate the bin first (`npm run twiml:fallback`).
   - **The dashboard now signs in only at `https://app.brockersby.co.uk`.** The API accepts a login made for its own address, and that's now the new one. A dashboard page opened at the old address (a bookmark, say) sends the browser on to the same page at the new one; the old address still answers calls, health checks and the call links in texts already sent.
5. **Clerk, production instance.** Clerk Dashboard, the **Development** switch at the top, **Create production instance**, clone the development settings, domain `brockersby.co.uk`. (Clerk's docs: SSO connections, integrations and paths don't copy over. The dashboard uses none of them.) Clerk's **Domains** page then lists its own DNS records (several CNAMEs); add each at Porkbun exactly as shown, and wait for Clerk to show them verified (it says up to 48 hours; usually minutes). Porkbun doesn't proxy records, so Clerk's warning about Cloudflare doesn't apply. If Clerk's certificate step hangs, its docs name CAA records as the usual cause: Porkbun's DNS list for brockersby.co.uk should have no record of type CAA.
   - **Sign-in method.** Clerk's shared Google sign-in is for development only; production needs your own Google OAuth client (Google Cloud console, a project, an OAuth consent screen set to **In production**, since "Testing" lets in only 100 listed users, and a web client ID with `https://app.brockersby.co.uk` as an origin and Clerk's redirect URI from its Google connection page), pasted into Clerk's Google connection with **Use custom credentials** on. Or turn Google off in the production instance and use email codes, which need nothing: simpler, and Google can be added any time.
   - **Keys.** The production instance's **API keys** page: the secret key (`sk_live_...`) into Key Vault as a new version of `clerk-secret-key`; the publishable key (`pk_live_...`) into the GitHub repository variable `CLERK_PUBLISHABLE_KEY`. If `OPTIONAL_SECRET_NAMES` lists `clerk-jwt-key`, it holds the development instance's key, which would refuse every production login: take it out of the list (the API then fetches the keys from Clerk), or give it a new version with the production instance's JWT public key. Then **Deploy**, `release` (the publishable key is built into the dashboard, so this one needs the rebuild).
   - **Everyone's login is new.** Production is a new Clerk instance, so every person gets a new Clerk ID, and an account here is tied to the old one. Before each person's first production sign-in: **Deploy**, `task`, `reset-login --email <their address>`. Their next sign-in with that verified email claims the account again. Do yours, then sign in at `https://app.brockersby.co.uk`.
6. **Afterwards.** UptimeRobot can stay on the Azure address (its checks don't go through Clerk), or move to the new one. RUNBOOK and DEMO.md references to the dashboard's address become `https://app.brockersby.co.uk`.

To undo: `CUSTOM_DOMAIN_STAGE` back to `bind` and `apply`, then the `live-configure-number` task again (the agents follow by themselves); the generated address was never switched off. At `bind`, `ALTERNATE_BASE_URL` is the custom domain, so calls carry on during an undo too.

## 17. Billing (Step 12, decision 019)

Businesses pay by Direct Debit through GoCardless: £99 a month ex VAT with 200 minutes, then 20p a minute (the prices are in `packages/shared/src/plans.ts`). Each business's billing month runs from the day it went live. Nothing is ever switched off automatically for not paying.

### Connecting GoCardless

GoCardless has two separate places: the **sandbox** (`manage-sandbox.gocardless.com`: fake banks, no money) and the **live** account (`manage.gocardless.com`: needs Brockersby verified, a day or two). Each has its own access token and its own webhook. Start with the sandbox. While the server is on the sandbox, the Admin page's Billing section says so in red, and the API's log says so at start-up: real customers on it would "pay" with no money moving.

1. **Access token.** The GoCardless dashboard, **Developers**, **Create**, **Access token**, read-write. Locally: `GOCARDLESS_ACCESS_TOKEN` in `.env` (and `GOCARDLESS_ENVIRONMENT=live` only with a live token). On Azure: Key Vault `gocardless-access-token` (and `gocardless-environment` = `live` later), both in `OPTIONAL_SECRET_NAMES`, then **Deploy**, `apply`.
2. **Webhook.** The GoCardless dashboard, **Developers**, **Webhooks**, **Create webhook endpoint**: URL `https://<the API's address>/webhooks/gocardless` (locally, the ngrok address). It shows a secret: `GOCARDLESS_WEBHOOK_SECRET` in `.env`, or Key Vault `gocardless-webhook-secret` in `OPTIONAL_SECRET_NAMES`. Without it, every webhook is refused (and the API log says so at startup).
3. **Try it.** A business's **Account** tab, **Plan and payment**, **Set up Direct Debit**. In the sandbox, GoCardless's page accepts its own test bank details (it says which on the page). Back on the Account page, it shows "Set up", and the business's onboarding checklist ticks "Direct Debit set up".

### Charging

Every morning at 06:00 UK time the worker charges each paying business's billing months that ended (the demo line and test businesses never pay). For each month it works out the fee (the pilot's, or £99), the overage (the month's billable seconds rounded up to whole minutes once, 20p each over 200) and VAT if registered; records it; asks GoCardless for the payment; and emails the receipt. Each month is charged once: a run that stops part-way is finished by the next, and GoCardless is asked with a key that stops it taking the same month twice. A pilot's free month inside its minutes is recorded as nothing due, with no payment and no email. A business that asks to leave is charged for the month it left in, and none after.

The business sees each month on its Account page (what it was, and whether it's been collected); the business list shows you and Ant each one's Direct Debit and last month, without amounts.

**VAT**, once Brockersby is registered: four settings together, in Key Vault and `OPTIONAL_SECRET_NAMES`, then `apply`: `vat-registration-number` (GB and 9 digits), `vat-registration-from` (the date VAT is charged from, YYYY-MM-DD), `vat-seller-name` (the name you're registered under) and `vat-seller-address` (your address as registered, on one line, commas between its parts). The apps refuse to start with the number and without the name and address. From then, each billing month starting on or after the date has 20% added and gets a **VAT invoice** instead of a receipt, with everything HMRC lists ([VAT Notice 700/21, section 4.1](https://www.gov.uk/guidance/record-keeping-for-vat-notice-70021#vat-rules)): a number in one unbroken series (0001, 0002, ...), the date (the morning it's charged), your name, address and VAT number, the business's name and its billing address, and each line with its quantity, unit price, VAT rate and amount before VAT, then the totals. The invoice is stored with the charge exactly as issued, emailed, and numbered on the business's Account page. **Before switching it on:** ask each business to fill in **Billing address** on its Account page. An invoice made out to a business with none says "Address not given" (and the worker's log says which), which HMRC's list doesn't allow for: send that business a corrected invoice by hand once it's added. A full invoice rather than HMRC's simplified one (allowed up to £250 including VAT): the notice doesn't say a VAT-registered customer can reclaim VAT on a simplified one, and a busy month can pass £250.

### When something goes wrong

- **A Direct Debit ended** (`payment-mandate-ended`, section 11): the business cancelled it at their bank, or the bank refused it. Its Account page shows why. They set it up again from the same tab.
- **A payment failed** (`billing-payment-failed`): see section 11. The business was emailed (each time a payment fails, including after Collect again). **Collect again** on Admin, Billing asks GoCardless to retry the same payment; the charge follows it through to paid. GoCardless allows three retries of a payment.
- **A payment was cancelled**: GoCardless can't retry it. **Collect again** on Admin, Billing makes a new payment for the same month from the business's active Direct Debit, and the month follows the new one. Nothing does this by itself, so tell the business first: it gets no email from us about the new payment. The button only shows while the business has an active Direct Debit; without one, it's refused with "no active Direct Debit", and the business sets one up from its Account tab first. Pressing it twice makes one payment. If the new one is cancelled too, Collect again makes another.
- **A chargeback was reversed** (GoCardless's `chargeback_cancelled`): the month goes back to paid by itself, and the audit log records `billing.chargeback-cancelled`. Nobody is emailed or alerted.
- **Suspending a business** (for not paying, or anything else): its Account page, **Suspension** (admin only). Callers get the voicemail until you resume it, and its own switch and texts can't turn it back on. Nothing ever does this automatically. A month it spends suspended from start to end isn't charged; any month with some service is (decision 019).
- **A month is owed with no Direct Debit** (`billing-no-mandate`): it's collected the morning after one is set up.
- **"Set up Direct Debit" says it isn't available**: `GOCARDLESS_ACCESS_TOKEN` isn't set where the API runs.
- **Set up on GoCardless's page but the tab still says "started"**: the webhook isn't reaching the API (check the endpoint's URL and secret in the GoCardless dashboard, which lists each delivery and its answer). The tab's **Check again** button asks GoCardless directly.

## 18. Voicemail transcription (decision 022)

A caller who gets the fallback voicemail (the assistant unavailable, a paused or suspended business, the kill switch) leaves a recording. Nobody reads it: the tradesperson gets a text and an email saying a voicemail was left, with a link to listen. "I smell gas" left on one arrives as a routine text. With this switch on, each voicemail's recording is sent to Twilio to transcribe; the words come back in seconds, get the same summary and urgency as a call, and the tradesperson's text and email carry the summary. An emergency in the words sends the emergency text at once.

**It costs money, so it's off until you turn it on:** Admin, Overview, the **Voicemail transcription** card. Twilio charges $0.024 a minute for its Batch Transcription (its US price page, October 2026), about 2p; the estimate counts each voicemail as whole minutes, rounded up, because Twilio's page doesn't say how it rounds. The card shows the last 30 days' voicemails and what transcribing them all would have cost, so you can judge it before a penny goes; once on, it shows how many were asked for, done and failed, and the estimated spend. The month's Costs page gets a Transcription column. Turning it off stops new requests at once; results already asked for still arrive.

**What changes when it's on.** The "new voicemail" text and email wait up to 45 seconds for the transcript, so they carry the summary in one message (a call gets one text and one email, so a transcript that comes later than that shows on the call page and the dashboard only; an emergency in it still sends the emergency text). Twilio won't transcribe a recording under two seconds, so none is asked for. Twilio keeps nothing: the words come to the API in the result and are stored on the call like a call's transcript, under the same 12-month retention. The transcript shows on the call page and in the data download like any other.

**The first time you turn it on, check it works** (the real Twilio API wasn't tried while building it: Twilio's own examples authenticate differently from how the rest of this adapter does, and how it signs the result wasn't documented in full):

1. Turn the switch on, then the kill switch on, and leave yourself a 10-second voicemail on the demo number saying a name and "the boiler's leaking". Kill switch off again.
2. Within a minute, the card's **Asked for** line should show 1, then 1 done. The text that arrives should start "New enquiry (voicemail):" with a summary, not "New voicemail (10 sec)".
3. If the card shows 1 failed, section 11's `voicemail-transcription-failed` has the first checks. If it shows 1 waiting for more than two minutes: the worker's log for "Voicemail transcription requested" (it wasn't asked for: look just before it for Twilio's answer, most likely a 401 if the account credentials don't work on `voice.twilio.com`), and the API's log for "Rejected Twilio webhook" (the result arrived but its signature didn't check out). Either way, turn the switch off and send me the log lines: the plain voicemail message still went, so nothing was lost.

**What it doesn't do.** A voicemail whose result never arrives (the API down at that moment) isn't asked for again. The bin voicemail Twilio plays when the API is down (section 16) is transcribed too, once reconciliation stores it, if the switch is on.
