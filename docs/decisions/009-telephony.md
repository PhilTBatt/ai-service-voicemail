# 009: Telephony: how calls reach the agent, the Twilio account, and local testing

- **Date:** 2026-11-06
- **Status:** accepted (the account choice is Phil's; see "Twilio account")
- **Code:** `apps/api/src/providers/telephony*.ts`, `twilio.ts`

## 1. Calls reach Retell by "Dial to SIP", not SIP trunking

Retell offers two ways to connect our own numbers ([custom telephony](https://docs.retellai.com/deploy/custom-telephony.md)):

1. **Elastic SIP trunking** (Retell's recommendation): Twilio routes the number straight to Retell's SIP server. Our API isn't in the call path.
2. **Dial to SIP URI**: our API answers Twilio's voice webhook, calls Retell's [Register Phone Call API](https://docs.retellai.com/api-references/register-phone-call.md) (which takes the agent and the per-call variables), and returns TwiML `<Dial><Sip>sip:{call_id}@sip.retellai.com</Sip></Dial>`. The dial must happen within 5 minutes of registering.

**Chosen: Dial to SIP.** BUILD_PLAN Step 4 routes every call by tenant status (agent, fallback voicemail, "this service has ended", or the kill switch). With trunking, Twilio never asks us, so that routing would have to happen at Retell, and Retell's only answer for a call it won't take is to reject it, which gives the caller a failure tone rather than our ended message. With Dial to SIP:

- the API decides per call, including the kill switch and blocked numbers;
- the per-call variables (`{{open_now}}`, `{{holiday_mode}}`) are passed in the register call, so no separate inbound webhook is needed;
- Twilio's **fallback URL** on the number (the static voicemail, hosted apart from the API) covers an API outage, exactly as the plan's architecture diagram shows;
- the number doesn't need importing into Retell, so the `attachNumber` step and its "number not found" failure (seen in Step 3's live check) go away. The next change replaces it with `registerInboundCall`.

Costs: the API is in the path of every live call (one HTTP round trip to Retell before the dial, well inside Twilio's 15-second limit), and Retell's own transfer feature isn't available (the plan doesn't use it).

**Confidence:** medium-high. **Strongest case against:** trunking keeps calls flowing during an API outage without the voicemail detour, and Retell recommends it. The ended message and status routing matter more, and the fallback voicemail is the plan's accepted answer to outages.

## 2. Twilio adapter: REST via fetch, signatures via the SDK

- Number search, purchase, configuration and release use Twilio's REST API directly, so the adapter is tested offline against a stub (as the Retell adapter is). Fields from Twilio's docs and SDK typings: `AvailablePhoneNumbers/GB/Local` (`VoiceEnabled`, `Contains`, `PageSize`); `IncomingPhoneNumbers` (`PhoneNumber`, `VoiceUrl`, `VoiceFallbackUrl`, `BundleSid`, `AddressSid`).
- Webhook signatures use `twilio.validateRequest` from the SDK. Twilio's [webhook security docs](https://www.twilio.com/docs/usage/webhooks/webhooks-security) say the parameter set changes over time and to use the SDK rather than reimplementing HMAC-SHA1 over the URL and sorted parameters. This is the legacy middleware's approach, carried over (decision 000).
- **Purchases are guarded twice:** the adapter must be created with purchases enabled (`TWILIO_PURCHASES_ENABLED=true`, default off) and the call must pass `{ live: true }`. Only `live-*` scripts and admin actions do both. A refused purchase makes no request at all.

## 3. Twilio account

Twilio's [trial docs](https://www.twilio.com/docs/usage/tutorials/how-to-use-your-free-trial-account) (read 2026-11-06): trials expire after 30 days, can only reach up to 5 verified numbers, and use Twilio-chosen trial numbers. A real UK test number therefore needs an **upgraded account with a small prepaid balance and auto-recharge off**, which is what BUILD_PLAN's "Before you start" allows.

Options for Phil:

- **Reactivate the old "AI Voicemail Service" account** (suspended, probably from a zero balance). It may already be upgraded. Before use: rotate its auth token and delete old API keys (PROGRESS, Step 2 note).
- **A new account, upgraded with a small balance.** Cleaner history; the regulatory bundle has to be created from scratch either way.

**UK geographic numbers need a regulatory bundle.** Per [Twilio's UK guidelines](https://www.twilio.com/en-us/guidelines/gb/regulatory), a **business** supplies the business name, registration authority and number, website, UK address, and an authorised representative's name and mobile, with **no documents**. Submit under PhilCo. Approval can take days, so start it as soon as the account is chosen. The adapter sends the approved `BundleSid` and `AddressSid` with every purchase.

## 4. Local testing: a tunnel with a stable URL

Twilio and Retell need a public HTTPS URL that reaches the laptop, and Twilio signs the exact URL, so `PUBLIC_BASE_URL` must match it.

- **ngrok (chosen):** its free plan includes one static domain, so `PUBLIC_BASE_URL` stays the same between runs and the number's webhook URLs never need updating. Needs a free ngrok account. (My understanding of the current free plan; Phil confirms on ngrok.com/pricing when setting it up.)
- **Cloudflare quick tunnels:** free with no account, but a new random URL every run, so every run means reconfiguring the number.
- **VS Code port forwarding / dev tunnels:** free with a GitHub account and can be persistent; fine as a fallback.

**Confidence:** medium.

## 5. Fallback voicemail: a TwiML Bin, not a Function

The static voicemail must work when the API is down, so it can't live on the API.

- **TwiML Bins (chosen):** static TwiML hosted by Twilio, free, nothing to deploy. Two bins, because Twilio's bin editor rejects Handlebars templating (tried 2026-11-06, "Your TwiML syntax is invalid"): bin 1 says "Thanks. Goodbye." and hangs up; bin 2 plays the greeting and records, with `<Record action>` pointing at bin 1 and `recordingStatusCallback` pointing at the API. `npm run twiml:fallback` prints bin 1, then bin 2 with `--done-url`. Bin 2's URL is the number's fallback URL.
- **Twilio Function:** code that Twilio hosts. More flexible, but it needs a service, a deploy and a runtime to keep up to date, for a page that never changes.

The recording callback (`recordingStatusCallback`) is how the API learns about a voicemail. Twilio doesn't retry it, so the **reconciliation job** (`reconcile-voicemails`, every 15 minutes, 24-hour window) lists recent recordings and stores any that have no call row. Storing is idempotent on Twilio's CallSid, so the callback and the job can both see a recording safely.
