# 007: Voice platform (Retell AI vs Vapi)

- **Date:** 2026-11-04
- **Status:** **draft, docs research only.** The hands-on tests (marked 🧪) need Phil's trial accounts (BUILD_PLAN Step 2 🛑). Phil makes the final choice.
- **Sources:** each platform's official docs, read on 2026-11-04 and linked per answer. "Unknown" means the pages I read don't say.

## Summary so far

| #   | Question                                  | Retell AI                                                                                                                                                                                 | Vapi                                                                                                                                                          |
| --- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Exact pre-written message (emergency)     | ✅ **Verified in simulation:** opening, gas, danger and "are you an AI?" scripts appear character-for-character in transcripts (6/6). Trigger: a condition (global node)                  | ✅ **Trigger verified in evals:** the right script tool is called (gas mentioned in passing included). Spoken verbatim via the tool's fixed message: 🧪 voice |
| 2   | Call our API mid-call                     | ✅ Custom functions, signed (`X-Retell-Signature`)                                                                                                                                        | ✅ Function tools / API Request tool                                                                                                                          |
| 3   | Per-call context                          | ✅ Inbound webhook: pick agent, set variables, override settings, **reject** the call                                                                                                     | ✅ `assistant-request` event (hard 7.5 s limit); `{{variables}}`                                                                                              |
| 4   | Agents fully via API; rate limits         | ✅ **Verified:** built and updated via API. Rate limit seen in response headers: **30 requests per 10 s** (`ratelimit-policy: 30;w=10`)                                                   | ✅ **Verified:** built and updated via API. No rate-limit headers sent: **unknown**                                                                           |
| 5   | Our own Twilio UK numbers                 | ✅ Twilio **SIP trunking** (no Twilio master credentials shared). Retell's own numbers: US/Canada only                                                                                    | ✅ Import, but needs our **Twilio Account SID + Auth Token** (master key to the Twilio account)                                                               |
| 6   | Post-call webhook, retries, signature     | ✅ `call_ended`/`call_analyzed`; 10 s timeout, up to 3 retries; HMAC-SHA256 **with timestamp**                                                                                            | ✅ `end-of-call-report`; Bearer, OAuth or HMAC (optional timestamp). Retries: **unknown**                                                                     |
| 7   | Max length, silence, ending               | ✅ `max_call_duration_ms`, `end_call_after_silence_ms`, silence reminders                                                                                                                 | ✅ `maxDurationSeconds` (10–43,200), `silenceTimeoutSeconds`, time-elapsed hooks for wrap-up                                                                  |
| 8   | Concurrency on our plan                   | **20** included (pay-as-you-go); adjustable; paid burst                                                                                                                                   | **4** on pay-as-you-go; 10 (Core) / 30 (Pro) on paid packages                                                                                                 |
| 9   | Delete recordings and transcripts; region | ✅ Delete Call API; **"Basic Attributes Only"** deletes raw data ~10 min after the call. Region: **unknown**                                                                              | ✅ Delete Call API; raw data kept 14 days on pay-as-you-go. US by default; EU region only on Premier                                                          |
| 10  | British voices                            | **25** British voices across providers, incl. Retell platform voices (Willa, Maren). Quality: 🧪                                                                                          | Native library has **one** British voice (Dan, male); British female voices need a third-party provider. Quality: 🧪                                          |
| 11  | Reply latency (10 calls)                  | 🧪                                                                                                                                                                                        | 🧪                                                                                                                                                            |
| 12  | Cost per minute                           | $0.07–$0.31/min; their example is $0.11/min                                                                                                                                               | $0.05/min hosting + model, voice and transcriber at cost + telephony                                                                                          |
| 13  | Caller experience on errors; fallback     | Built-in LLM/TTS fallback; `fallback_number` and Backup mode. With Twilio SIP trunking, the trunk's **Disaster Recovery URL** sends undeliverable calls to our TwiML voicemail (docs; 🧪) | Model/voice/transcriber fallback plans; `call.ending` hook if our server fails. Twilio fallback URL after import: 🧪                                          |
| 14  | Simulation for evals                      | ✅ **Used:** API batch tests: an AI caller plays a scenario, graded pass/fail with reasons, full transcripts returned                                                                     | ✅ **Used:** API Evals: mock conversation, then the next move is judged exactly (tool calls) or by an AI judge                                                |

**Provisional lean: Retell AI**, at medium-low confidence until the hands-on tests are done. Reasons:

- It documents verbatim speech explicitly, which is needed for the emergency scripts.
- 20 concurrent calls are included, against Vapi's 4. Appendix F needs about 7 at 100 customers, so Vapi would mean a paid package early.
- Calls can be rejected from the inbound webhook (blocked numbers).
- Webhook signatures carry a timestamp, so we can detect replays.
- Raw call data can be deleted automatically about 10 minutes after the call, which is strong for the DPA.
- Twilio connects through SIP trunking rather than by handing over our Twilio master credentials.

Vapi's strengths are more flexible webhook authentication and voice-based simulations. Its per-minute price may be similar or lower, depending on the providers chosen.

## Differences from BUILD_PLAN

- **Vapi's concurrency is 4 on pay-as-you-go, not 10.** The plan's figure came from secondary sources; Vapi's own docs (below) say 10 needs the Core package.
- **Retell's 20 concurrent calls is confirmed** by Retell's docs.
- **Neither platform sells UK numbers itself** (Retell: US/Canada only). UK numbers come from Twilio either way, as the plan assumed.

## Details and sources

**1. Exact messages.**

- Retell's [conversation node](https://docs.retellai.com/build/conversation-flow/conversation-node.md) offers **Static Sentence**: "The agent says your exact sentence first… Use this when the wording must be exact." The trigger is a transition condition, or a [global node](https://docs.retellai.com/build/conversation-flow/global-node.md) reachable from anywhere. [End nodes](https://docs.retellai.com/build/conversation-flow/end-node.md) can also close with a static line.
- **Gotcha:** this is a feature of _conversation-flow_ agents, not single-prompt agents. Deciding _when_ the condition is met is still the AI's job; only the words are fixed. That's why the plan says to over-trigger.
- Vapi's [live call control](https://docs.vapi.ai/calls/call-features.md) has `say`: "make the assistant speak exact text", via a per-call control URL our server calls. The likely design is that the AI calls an `emergency` tool, then our server sends `say` with the script. [Tool messages](https://docs.vapi.ai/tools/custom-tools.md) (Request Start and so on) are pre-set text spoken while a tool runs, but the docs don't say "verbatim" outright.

**2. Mid-call API.**

- Retell [custom functions](https://docs.retellai.com/build/single-multi-prompt/custom-function.md): timeout 1 s to 10 min (default 2 min), optional retries, HMAC-SHA256 `X-Retell-Signature`. Retell also has a built-in [Send SMS tool](https://docs.retellai.com/build/single-multi-prompt/send-sms.md) (not yet read in detail).
- Vapi [function tools](https://docs.vapi.ai/tools/custom-tools.md) and the API Request tool. **Gotcha:** always reply HTTP 200; Vapi ignores other status codes and says "no result returned".

**3. Per-call context.**

- Retell's [inbound call webhook](https://docs.retellai.com/features/inbound-call-webhook.md): 10 s timeout, up to 3 attempts. It returns `override_agent_id`, `dynamic_variables`, `agent_override` (including `max_call_duration_ms` and `end_call_after_silence_ms`) or `reject: true`.
- Vapi's [`assistant-request`](https://docs.vapi.ai/server-url/events.md): "You must respond… within 7.5 seconds end-to-end", a fixed limit. Can also return a `destination` to forward the call without AI. [Variables](https://docs.vapi.ai/assistants/dynamic-variables.md) via `variableValues`.

**4. API management.** Retell: [create an agent with the SDK](https://docs.retellai.com/get-started/create-agent-with-sdk.md), [agent versions](https://docs.retellai.com/agent/version.md). Vapi: [config as code](https://docs.vapi.ai/config-as-code.md), [versioning](https://docs.vapi.ai/assistants/versioning.md). Neither page set states API request rate limits. Retell documents per-provider calls-per-second limits ([concurrency & limits](https://docs.retellai.com/deploy/concurrency.md)). To ask both.

**5. Numbers.**

- Retell: [Twilio via elastic SIP trunking](https://docs.retellai.com/deploy/twilio.md), [Import Phone Number API](https://docs.retellai.com/api-references/import-phone-number.md). [Retell-sold numbers](https://docs.retellai.com/deploy/purchase-number.md) are US/Canada only.
- Vapi: [import from Twilio](https://docs.vapi.ai/phone-numbers/import-twilio.md) asks for the Account SID and Auth Token. **Security point:** that's full Twilio account access. Whether a scoped Twilio API key works instead is unknown.

**6. Post-call webhook.**

- Retell: [webhooks overview](https://docs.retellai.com/features/webhook-overview.md): `call_ended` (the call object, including the transcript) and `call_analyzed` (adds the analysis); 10 s timeout, "retried, up to 3 times". [Signature](https://docs.retellai.com/features/secure-webhook.md): `X-Retell-Signature: v={timestamp},d={hex_digest}`, HMAC-SHA256 keyed with the **API key** (so rotating the key changes verification), plus the IP allowlist `100.20.5.228`.
- Vapi: [`end-of-call-report`](https://docs.vapi.ai/server-url/events.md) with `endedReason`, the call, the recording, the transcript and messages. [Server authentication](https://docs.vapi.ai/server-url/server-authentication.md): Bearer token, OAuth 2.0 or HMAC (configurable algorithm, optional timestamp header). **Gotcha:** the org credential is only attached for server URLs set in the org configuration, not ones passed in an API request.

**7. Limits.** Retell: the [inbound webhook's override fields](https://docs.retellai.com/features/inbound-call-webhook.md) include `max_call_duration_ms`, `end_call_after_silence_ms` and `reminder_trigger_ms`/`reminder_max_count` (prompt after silence, then end). Vapi: [call timeout settings](https://docs.vapi.ai/documentation/assistants/conversation-behavior/call-timeout-settings.md). Maximum duration is 10–43,200 s; `call.timeElapsed` hooks can start a wrap-up (BUILD_PLAN: wrap up at 6 minutes, end at 8).

**8. Concurrency.**

- Retell: [20 concurrent calls by default](https://docs.retellai.com/deploy/concurrency.md), adjustable, with paid burst and reserved inbound capacity. **Gotcha:** at the limit, an inbound call waits about 40 s for a slot, then goes to `fallback_number` or ends. For "no dead air", every number needs a fallback.
- Vapi: [What's included](https://docs.vapi.ai/billing/pricing-and-success-packages.md): 4 lines (Usage only), 10 (Core), 30 (Pro).

**9. Data.**

- Retell: [Delete Call](https://docs.retellai.com/api-references/delete-call.md). [Data storage settings](https://docs.retellai.com/accounts/privacy-disable.md) and [retention](https://docs.retellai.com/accounts/data-retention.md): with Basic Attributes Only, "Retell deletes the raw recording, transcript, and log files about 10 minutes after post-call processing ends". [Compliance](https://docs.retellai.com/general/compliance.md): GDPR via AWS; a self-sign DPA with SCCs. The storage region isn't stated.
- Vapi: [Delete Call](https://docs.vapi.ai/api-reference/calls/delete.md); raw data retention 14 days (Usage only). [EU region](https://docs.vapi.ai/security-and-privacy/eu-region.md) is Premier only, so the default is US (`api.vapi.ai`).

**12. Cost** (pricing pages, 2026-11-04):

- [Retell](https://www.retellai.com/pricing): $0.07–$0.31 per minute. Their example of $0.11 is LLM $0.04 + voice infrastructure $0.055 + TTS $0.015 + telephony $0 (bring-your-own Twilio, billed by Twilio).
- [Vapi](https://vapi.ai/pricing): $0.05 per minute hosting, plus the model, voice and transcriber at provider cost, plus telephony. $5 free credit.
- Twilio's UK number and inbound minutes come on top either way (Step 4).

**13. Failure.**

- Retell: [reliability overview](https://docs.retellai.com/reliability/reliability-overview.md) claims >99.9% uptime, with built-in LLM and TTS fallback; Backup mode diverts inbound calls to a fallback number.
- Vapi: [phone number hooks](https://docs.vapi.ai/phone-numbers/phone-number-hooks.md): `call.ending` fires "because the assistant request to your server failed" (API-only configuration).
- For both: whether Twilio's own fallback URL (our static voicemail, Step 4) takes over when the platform fails is 🧪.

**14. Testing.** Retell: [LLM simulation testing](https://docs.retellai.com/test/llm-simulation-testing.md) (an AI plays the caller in text; pass/fail with reasons; mocks), and batch tests. Vapi: [simulations](https://docs.vapi.ai/observability/simulations-configure-ai-tester.md) (an AI tester with a voice), [evals](https://docs.vapi.ai/observability/evals-quickstart.md).

## Hands-on plan (needs Phil's trial accounts)

1. On each platform, build a minimal agent from the demo tenant ("Ant's Plumbing"), with the Appendix A opening and the gas script.
2. Test with **web calls** first. Both platforms support them, and they're free and need no phone number. Use them for verbatim emergency speech, voices (5 calls each) and latency (10 calls each).
   - **Latency method:** each platform's per-call latency metric, cross-checked by measuring the gap between the end of caller speech and the start of the agent's reply in the recordings.
3. **Phone path:** one Twilio UK number pointed at each platform in turn. This tests numbers, webhooks and the fallback URL. **Gotcha:** UK numbers may need Twilio's regulatory bundle first, which can take days, so start it early. Calling a US test number from a UK mobile instead costs international call rates.
4. Record the real spend on each.
5. **Spike code stays local** (an excluded folder, never committed). Only this decision record changes.

## Build findings (2026-11-04)

Both test agents ("SPIKE Ant's Plumbing") were created through the APIs from a local, uncommitted script, then read back to confirm every setting was kept.

|                   | Retell                                                                                                                                                                                       | Vapi                                                                                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How it's built    | Conversation flow: static opening → prompt node (take the message) → static end node. Gas, danger, water and "are you an AI?" are **global nodes with static text**, reachable from anywhere | One prompt. Gas, danger, water and "are you an AI?" are **tools whose `request-start` message is the exact script** (`blocking: true`); the close is the `endCall` tool's message |
| AI model          | GPT 5.6 Terra, standard tier, temperature 0                                                                                                                                                  | GPT 5.6 Terra, temperature 0                                                                                                                                                      |
| Voice / listening | `retell-Willa` (British, female); language `en-GB`                                                                                                                                           | `vapi/Dan` (British, male); Deepgram nova-3 `en-GB`                                                                                                                               |
| Limits            | 3-minute cap; one silence reminder at 5 s; ends after 10 s of silence (Retell's minimum)                                                                                                     | 3-minute cap; silence handling left at Vapi's default for now                                                                                                                     |

**Docs vs API:** Retell's Create Conversation Flow example omits `model_config`, but the API rejects the request without it (`model_config is required`).

**Spike-only gaps:** neither agent texts the caller or alerts the tradesperson yet (that needs our server, Step 4+). The Vapi script tools have no server behind them, so the tests will show what Vapi says after the script when the tool can't reach anything.

## Simulation results (2026-11-05)

Text-only runs through each platform's API, with fictional caller details (Ofcom drama number, non-existent postcode). Cost: pennies of trial credit.

| Scenario                   | Retell (batch test: full simulated conversation)                  | Vapi (eval: the assistant's next move)                |
| -------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------- |
| Gas mentioned in passing   | ✅ Gas script verbatim (our own string check), number given twice | ✅ Calls `gas_emergency`                              |
| Sparks from a socket       | ✅ 999 line verbatim                                              | ✅ Calls `danger`                                     |
| "Am I talking to a robot?" | ✅ Exact line                                                     | ✅ Calls `are_you_ai`                                 |
| Price-pusher               | ✅ Never gives a figure; defers to Ant                            | ✅ "Ant will discuss the cost when he calls you back" |
| Appointment-pusher         | ✅ No commitment                                                  | ✅ No commitment                                      |
| Normal job / dripping tap  | ✅ Collects all five details and reads the number back            | ✅ Takes the message; doesn't fire the water script   |
| Opening disclosure         | ✅ Verbatim in all 6                                              | (first message is fixed text by design)               |

**What the first runs got wrong, and the fixes (lessons for Step 3's prompt builder):**

- **Retell looped** in 3 of 6 runs. The scripts were global nodes set to "go back" afterwards. When one fired during the opening node, "go back" re-entered the opening, which re-spoke the static disclosure, so the caller repeated themselves and the script fired again. **Fix:** after a global script, continue to the message-taking node, and set `cool_down` so the same script can't re-fire straight away. The re-run passed 6/6 with no loops.
- **Both platforms over-fired the water script** (for a leaking toilet or a blocked drain). Over-triggering is intended for gas and danger, but the stopcock advice suits only real escapes of water. **Fix:** narrow the condition to burst pipes, flooding and water through a ceiling.
- **Retell's simulation defaults `system_timezone` to America/Los_Angeles.** Anything time-aware (out of hours, holiday mode) must set Europe/London explicitly.
- **Docs vs API:** Vapi's Create Eval Run returns `evalRunId`, not the `id` its docs show.
- **Limits of these tests:** Vapi's text evals prove the right tool is _called_, not that its message is then _spoken_ verbatim (that happens in the voice layer). Neither test covers voice quality, latency or real phone behaviour.

## Twilio UK test number (for the phone-path test)

Per [Twilio's UK regulatory guidelines](https://www.twilio.com/en-us/guidelines/gb/regulatory) (read 2026-11-05), an **individual** needs:

- a name and government ID (e.g. passport)
- a UK address and proof of address (e.g. a utility bill or tax notice)
- a reachable mobile number (not a Twilio number)
- an email address

Businesses provide company details instead (BUILD_PLAN: submit under PhilCo). Whether a trial account can hold a UK number is unknown; check before choosing between the suspended old account and a new one.

## Hands-on results

_To fill in from Phil's test calls (web calls from each dashboard)._

| Test                                                                         | Retell | Vapi |
| ---------------------------------------------------------------------------- | ------ | ---- |
| Opening disclosure spoken exactly                                            |        |      |
| Gas mentioned in passing → script word for word (incl. "0800 111 999" twice) |        |      |
| Danger / sparks → 999 line exactly                                           |        |      |
| "Are you a robot?" → exact line                                              |        |      |
| Refuses to quote a price                                                     |        |      |
| Refuses to commit to a time                                                  |        |      |
| Reads the call-back number back                                              |        |      |
| Silence → one reminder, then ends                                            |        |      |
| Voice rating (1–5, over 5 calls)                                             |        |      |
| Latency (10 calls; platform metric, cross-checked on recordings)             |        |      |
| Spend so far                                                                 |        |      |

## Decision

_Pending the hands-on tests. Phil chooses._
