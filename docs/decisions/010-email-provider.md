# 010: Email provider for notifications

- **Date:** 2026-11-07
- **Status:** accepted 2026-11-08 (Postmark; Phil is buying a domain for the sending address). Adapter: `apps/api/src/providers/postmark.ts`.
- **Code:** `apps/api/src/providers/email*.ts` (the seam and fake), `jobs/notify-email.ts`. The provider adapter follows the pick.

## 1. What the email is for

After every call the tradesperson gets a text (done) and an email (BUILD_PLAN Step 6). The email carries what the text can't: the whole transcript, the caller's details laid out, and a link to the call page and recording. Voicemails get a "new voicemail" email with the link to listen. Later steps send onboarding, billing and account emails through the same provider (Steps 11 to 13), and Step 8's alerts may use it too.

So the emails contain **personal data about callers** (name, number, postcode, what they said). That makes "where is this processed and for how long" a real question, not a checkbox.

Volume is small. At roughly five calls a customer a day:

| Customers | Emails a month |
| --------- | -------------- |
| 10        | ~1,500         |
| 100       | ~15,000        |
| 500       | ~75,000        |

## 2. What matters, in order

1. **Deliverability** to the mailboxes tradespeople actually use (Gmail, Outlook and Hotmail, BT, Sky). A missed-call email that lands in spam is a missed call.
2. **Data handling:** where the content is processed and stored, for how long, and whether a Data Processing Agreement (DPA) is in place without paperwork.
3. **Effort for one developer:** account approval, DNS setup, bounce handling, a dashboard to answer "did it send?".
4. **Cost** at the volumes above.
5. **A maintained Node SDK** and webhooks for bounces and spam complaints (a bounce should raise an alert; a complaint should stop further mail to that address).

## 3. The three candidates

Facts read on 2026-11-07 from the pages linked. Prices are in US dollars, as published.

|                             | Postmark                                                                                                           | Resend                                                                                                                                | Amazon SES                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Free tier                   | 100 emails/month, never expires (testing only)                                                                     | 3,000/month, capped at 100/day, 1 domain webhook endpoint                                                                             | None specific to SES; new AWS accounts get up to $200 in credits for 6 months                                                               |
| Entry paid tier             | Basic $15/month for 10,000; extra $1.80 per 1,000. Pro $16.50 for 10,000; extra $1.30 per 1,000                    | Pro $20/month for 50,000; extra $0.90 per 1,000                                                                                       | Essentials plan: $0.16 per 1,000, no monthly fee (à la carte $0.10 per 1,000)                                                               |
| Where data lives            | US: Deft's data centre near Chicago and AWS. "We currently don't have plans to add servers in the EU."             | Sending can be from Ireland (eu-west-1), but "all account data, including email metadata, logs, and API records, is stored in the US" | The region you pick, with London (eu-west-2) and Ireland available. Regional residency is AWS's general commitment, not stated on SES pages |
| Content retention           | 45 days default; add-on for 7 or 28 days, or up to 365 on Pro+                                                     | 30 days on all self-serve plans                                                                                                       | Not retained unless the paid Archiving add-on is on (my reading; the docs don't say so outright)                                            |
| DPA                         | Built into the Terms of Service since 2021; nothing to sign                                                        | DPA document; the page doesn't describe a self-serve signing flow. 22 sub-processors listed, all US, including Anthropic and Google   | AWS's GDPR DPA is part of the service terms                                                                                                 |
| Approval                    | Manual review of every account, under 24 hours on weekdays. Until then only your own verified domains receive mail | Not stated                                                                                                                            | Sandbox: 200 messages a day to verified addresses only. Production access by form, initial response within 96 hours                         |
| Bounce and complaint events | Webhooks per stream, **not signed** (Basic auth and IP allowlist instead); retried, so duplicates arrive           | Signed webhooks (`email.bounced`, `email.complained`, `email.delivered`, and more); free plan allows 1 endpoint                       | SNS topics or event publishing to SNS and Firehose; more plumbing, no dashboard                                                             |
| Node SDK                    | `postmark` (Node 18+), maintained by Postmark                                                                      | `resend`, official                                                                                                                    | `@aws-sdk/client-sesv2`, part of AWS SDK v3 (npm page blocked the fetch; the package is the standard one)                                   |
| Dedicated IP                | $50/month, 300,000 emails/month minimum                                                                            | $30/month on Scale, above 3,000/day                                                                                                   | $24.95/month per IP                                                                                                                         |
| What it is underneath       | Its own infrastructure                                                                                             | Resend lists AWS as its "third party hosting and sending provider", so it sends through SES                                           | The thing itself                                                                                                                            |

Sources: [Postmark pricing](https://postmarkapp.com/pricing), [Postmark EU privacy and DPA](https://postmarkapp.com/eu-privacy), [Postmark approval](https://postmarkapp.com/support/article/1084-how-does-the-account-approval-process-work), [Postmark bounce webhook](https://postmarkapp.com/developer/webhooks/bounce-webhook); [Resend pricing](https://resend.com/pricing), [Resend regions](https://resend.com/docs/dashboard/domains/regions), [Resend DPA](https://resend.com/legal/dpa), [Resend sub-processors](https://resend.com/legal/subprocessors), [Resend webhook events](https://resend.com/docs/webhooks/event-types); [SES pricing](https://aws.amazon.com/ses/pricing/), [SES endpoints](https://docs.aws.amazon.com/general/latest/gr/ses.html), [SES sandbox](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html), [SES DMARC](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dmarc.html), [SES notifications](https://docs.aws.amazon.com/ses/latest/dg/monitor-sending-activity-using-notifications.html).

## 4. Cost at our volumes

| Customers | Postmark (Pro) | Resend                  | SES (Essentials) |
| --------- | -------------- | ----------------------- | ---------------- |
| 10        | $16.50         | $0 (if under 100 a day) | ~$0.25           |
| 100       | ~$23           | $20                     | ~$2.40           |
| 500       | ~$101          | ~$42 (Pro plus overage) | ~$12             |

Against revenue of £99 a customer a month, none of these numbers should decide it.

## 5. Recommendation: Postmark

**Why.** It scores best on the two things at the top of the list. Its deliverability reputation and tooling (separate transactional stream, 45 days of per-message activity, bounce and complaint webhooks, a clear dashboard) mean fewer missed-call emails lost to spam and quick answers when a customer says one never arrived. It is also the least work: one API token, three DNS records, and approval within a day. The DPA needs no signature.

**Why not Resend.** Underneath, it sends through SES. On top it adds a US-hosted dashboard, 30-day content storage in the US, and a long list of US sub-processors between us and the recipient. The EU sending region changes where the mail leaves from, not where our callers' data is kept. Its real advantages, the free tier and signed webhooks, don't outweigh that for mail containing transcripts.

**Why not SES.** It has the best data story: processing in London and no retained content by default, at the lowest price. It costs a second cloud account alongside Azure, the sandbox exit, bounce plumbing through SNS, and no dashboard without the paid Virtual Deliverability Manager. For a solo developer that's a week of friction spread over the project for a benefit the customers won't see.

**Confidence:** medium.

**Strongest case against the choice.** Postmark holds caller transcripts on US servers for 45 days, and we're a UK service telling customers their callers' data is handled carefully. Two mitigations, either of which Phil can pick with the provider:

- Shorten retention with Postmark's add-on (7 or 28 days). The pricing page is inconsistent about which plans allow it; confirm in the dashboard.
- Keep the transcript out of the email body and link to the call page instead. That deviates from BUILD_PLAN ("the same details plus the transcript") but the page is one tap away and already exists.

If UK residency is the deciding factor, pick SES in London and accept the plumbing. The seam is the same either way.

**Not evaluated:** Azure Communication Services Email. It would keep everything in one cloud at Step 8 and offers UK data residency, but BUILD_PLAN names these three and I haven't read its docs. Worth a look at Step 8 if Postmark's US hosting turns out to matter.

## 6. Before any of them can send

Every option needs a **domain we control** for the From address, with SPF, DKIM and DMARC records (DMARC starting at `p=none`, per the plan). Phil doesn't have one yet. Buying `answermate.co.uk` or similar costs about £10 a year and is a 🛑 purchase for Phil to make. Postmark's approval also asks for a website URL, which the same domain can provide once it has a one-page site.

Suggested addresses: `calls@` for notifications, with replies going to a monitored support address. Both the SMS sender name and the email domain should match the product name, so the two channels obviously come from the same place.
