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

Text the notification number from the demo tenant's registered mobile: `OFF`, `ON`, `HOLIDAY 12/12`, `STATUS`, `HELP`. The reply comes straight back. This needs a real mobile number as the sender; with an alphanumeric sender (`TWILIO_SMS_FROM=AnswerMate`) texts go out but replies can't come in.

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
3. Deploy. Every business is then asked on its dashboard to read and accept it (Account tab, "Documents"), and only its owner can. Until it does, a business still onboarding can't go live; its page tells an admin which documents are outstanding.
4. A live business keeps its service in the meantime (open question 6 in `docs/PROGRESS.md`).

### Step by step

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

## 9. When a business leaves

The tradesperson cancels on their Account tab (or you do, from theirs). From then on callers to
their number hear that the service has ended, and they get a text and an email with the codes
to turn their diverts off and get their voicemail back. The business appears under "Leaving
businesses" on the Admin page. After 30 days the "Release number" button appears: it gives the
number back to Twilio for good and marks the business cancelled.

The business then stays on that list as "number released, data still held", with a **Delete
data** button. Type the business's name when asked, and the worker deletes, in this order:

1. At Retell: each call's data, then the business's conversation flow and its agent.
2. At Twilio: the voicemail recordings, the call records for each number the business held
   (from when it was bought until it was released), and every text we sent about it.
3. At Clerk: the logins of the people whose only business this was.
4. The written confirmation: by email, or by text if the email can't go (outside production,
   only to addresses on `OUTBOUND_ALLOWLIST`).
5. Here: calls, messages, the assistant's settings, contact details and those people's
   accounts. The billing totals, the terms the business accepted and the account log stay.

The worker needs `ADMIN_DATABASE_URL`, the Twilio settings and `CLERK_SECRET_KEY` for this.
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

## 11. Alerts

An alert is an error line in the API's or the worker's log that starts `ALERT` and names it,
with IDs to look things up by. Logs never hold phone numbers, emails or call content. With
`ALERT_EMAIL` set (Key Vault `alert-email`, in `OPTIONAL_SECRET_NAMES`), each one is also
emailed there, with the same redacted details: at most one email per alert per 15 minutes,
the next one saying how many it stood in for. Outside production the address must be in
`OUTBOUND_ALLOWLIST`. The email is best effort: if Postmark is down, the log line still exists.
What the service can't email about is itself being down: that's the uptime check's job.

| Alert                                             | What it means                                                                                                                                                                  | First three checks                                                                                                                                                                                                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `job-dead-lettered`                               | A background job failed every retry and has stopped. The alert carries the job's data: which business and call                                                                 | 1. The worker log just before it, for the job's own error (same IDs). 2. Whether a provider was down, or a setting is missing from `.env`. 3. Once that's fixed, redo what made the job (save the profile again, say), or ask me                                                   |
| `voice-platform-unreachable`                      | A call came in and Retell wouldn't take it, so the caller got the fallback voicemail                                                                                           | 1. The API log line before it, for Retell's answer (401: the key; 404: the agent). 2. Retell's dashboard: is the business's agent there? 3. If every call does it, whether Retell has an outage; meanwhile the kill switch (section 13) sends every caller to voicemail on purpose |
| `agent-sync-failed`                               | A saved assistant profile couldn't be sent to Retell. The job retries, and the last synced agent keeps answering (a new business gets voicemail until its first sync)          | 1. The Admin page's failing syncs, with Retell's error. 2. An outage (it retries by itself) or a validation error. 3. If validation, fix the profile and save it again                                                                                                             |
| `call-extraction-failed`                          | The AI couldn't summarise a call. The tradesperson still got a text, saying to read the transcript                                                                             | 1. The worker log before it, for Anthropic's error (key, credit, outage). 2. Credit and keys in the Claude Console. 3. The call in the dashboard: an empty or unusual transcript?                                                                                                  |
| `summary-judge-failed`                            | The sampled quality check (`JUDGE_SAMPLE_RATE`) found a summary that doesn't match its call                                                                                    | 1. Read the call: summary against transcript. 2. If it misled, tell the tradesperson. 3. Keep the case for the evals (`npm run evals`)                                                                                                                                             |
| `guardrail-hit`                                   | The transcript shows the agent saying something it mustn't: a price, a promised time, or safety advice beyond the scripts                                                      | 1. Read the transcript at the rule named. 2. Check the business's profile for wording that invited it. 3. Tell the tradesperson if the caller was told something wrong, and keep the case for the evals. 4. Mark it reviewed on the Admin page, which takes it out of the queue    |
| `notification-no-mobile`, `notification-no-email` | A call's text or email couldn't go: the business has no mobile or email set                                                                                                    | 1. The business's Account tab. 2. Ask the tradesperson for it. 3. Tell them about the calls since: those messages aren't resent                                                                                                                                                    |
| `sms-undelivered`                                 | Twilio says a text didn't reach the phone. The alert has Twilio's error code                                                                                                   | 1. The code in Twilio's error list (twilio.com/docs/api/errors). 2. The mobile on the Account tab. 3. Whether the phone is on, or its network has trouble                                                                                                                          |
| `recipient-opted-out`                             | The tradesperson's phone replied STOP to our number, so texts to it fail (Twilio error 21610)                                                                                  | 1. Ask them to text START to the same number. 2. Email still reaches them meanwhile. 3. Check it's the right mobile                                                                                                                                                                |
| `email-bounced`, `email-spam-complaint`           | Postmark couldn't deliver a summary email, or the person marked it as spam. If the alert says `addressDeactivated`, Postmark won't send to that address until it's reactivated | 1. The address on the Account tab. 2. Postmark's activity for the message, and the reason. 3. Once it's fixed, reactivate the address in Postmark                                                                                                                                  |
| `number-bought-not-recorded`                      | A number was bought at Twilio but couldn't be saved here: it's costing money and isn't attached to the business                                                                | 1. Twilio's console, Phone Numbers: the SID in the alert. 2. The API log for the database error. 3. Ask me to attach it, or release it in Twilio's console                                                                                                                         |
| `deletion-confirmation-not-sent`                  | A business's data was deleted, but neither email nor text could carry the written confirmation                                                                                 | 1. The business named in the alert. 2. Your own records for how to reach them. 3. Confirm the deletion to them in writing another way, and keep a copy                                                                                                                             |
| `fallback-voicemail-spike`                        | More than 2 callers in 15 minutes got the fallback voicemail, for any reason: Retell down or slow, agents not synced, or businesses paused. Once per burst, per API copy       | 1. The API log just before: `voice-platform-unreachable` means Retell; "ran out of time" means something slow; otherwise the routing reason. 2. Retell's status page. 3. If Retell is down and stays down, the kill switch (section 13) is the honest version of the same thing    |
| `webhook-signature-spike`                         | More than 10 webhooks in 15 minutes had a bad signature (`source` says Twilio or the voice platform). Someone is probing, or a key changed on one side only                    | 1. Whether the auth token or webhook key was rotated (section 14) without the other side. 2. The log lines' paths: real routes or random ones (a scanner)? 3. If it's one address hammering, Azure's ingress can block it; otherwise nothing to do, forgeries are refused          |
| `server-error-spike`                              | More than 5 requests in 15 minutes ended in a 500. The alert names the last path                                                                                               | 1. The API log's "Unhandled request error" lines, for the error itself. 2. `/readyz` (the database) and the worker's check-in on the Admin page. 3. If it started with a release, release the previous commit                                                                      |

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
2. Microsoft says it takes from a few minutes to a few hours. The restore drill (Step 14) will
   time ours once production exists.
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

**Optional ones** (only if you use them): `alert-email` (where alerts are emailed, section 11), `retell-webhook-key`, `clerk-jwt-key`, `twilio-bundle-sid`, `twilio-address-sid`, `email-reply-to`. Add each one you use to the `production` environment variable `OPTIONAL_SECRET_NAMES` as a JSON list, for example `["retell-webhook-key"]`, so the apps read it.

### The first release, in order

1. All the secrets above in Key Vault.
2. **Deploy**, `database-setup`: builds the image, then creates the three database logins with those passwords. Once only (running it again just sets the passwords again).
3. **Deploy**, `release`: builds the image, runs the migrations, starts the API and the worker, and checks the API answers. The log ends with its address: `https://callmate-api.greengrass-a4449d88.uksouth.azurecontainerapps.io`.

After that, every release is just step 3.

### Running a script against production (the `task` step)

**Deploy**, `task`, with the script's name and arguments in the **command** box, for example `invite-user --email you@example.com --role admin`. It runs that script from `apps/api/src/scripts` in the `callmate-task` job, which has the apps' image and every setting they have, and prints the script's output in the Actions log. The job is created by a release, so the first `task` needs a release before it. Whatever is typed in the box is visible in this public repository's run log, so a script that needs contact details reads them from Key Vault instead: add the optional secrets `demo-mobile` and `demo-email` and list them in `OPTIONAL_SECRET_NAMES` before the demo business step below.

### The demo business in production, in order

The live database starts empty: no businesses, no logins. The demo line (the number Ant and prospects call) is the seed's first business, "Ant's Plumbing", with the same fixed ID as on a laptop, so every script that knows the demo business finds it.

1. Key Vault: `demo-mobile` (where the demo line's texts go, `+44...`) and `demo-email`; add both to `OPTIONAL_SECRET_NAMES` (`["alert-email","demo-mobile","demo-email"]`, say) and **Deploy**, `release`, so the apps and the task job read them.
2. **Deploy**, `task`: `invite-user --email <your login email> --role admin`. Your first login to the live dashboard then claims it.
3. **Deploy**, `task`: `create-demo-business --number +44... --sid PN...`, the demo line's number and its SID from Twilio's console (Phone Numbers, the number, its SID). It creates the business, records the number and saves the agent profile; the worker syncs the profile to Retell (a new agent there, separate from the laptop's).
4. **Deploy**, `task`: `live-configure-number --confirm`. Points the number at the live API, so calls stop going to the laptop. The number's fallback stays the TwiML Bin voicemail.
5. Call the number. The call shows on the live dashboard; the text and the email arrive at `demo-mobile` and `demo-email`.

To hand the number back to a laptop for a day, run `npm run live-configure-number -- --confirm` locally (with ngrok up); step 4 takes it back.

### The uptime check (decision 018)

The one thing the service can't email about is being down, so something outside asks it every five minutes. UptimeRobot, free plan, two monitors of type HTTP(s), each alerting the same address as `ALERT_EMAIL`:

| Monitor | URL                                                                                     | Means, when it fails                                                    |
| ------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| API     | `https://callmate-api.greengrass-a4449d88.uksouth.azurecontainerapps.io/readyz`         | The API is down, or can't reach the database (section 5's first checks) |
| Worker  | `https://callmate-api.greengrass-a4449d88.uksouth.azurecontainerapps.io/healthz/worker` | The worker hasn't checked in for two minutes: no texts, emails or syncs |

When one fires: the Azure portal, the app (`callmate-api` or `callmate-worker`), **Log stream** for the live output, and **Revisions and replicas** for whether Azure could start it at all. A release that broke it is undone by releasing the previous commit.
