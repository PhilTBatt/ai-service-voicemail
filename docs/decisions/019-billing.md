# 019: Billing: Direct Debit first, monthly on the go-live anniversary, AnswerMate plans only (Step 12)

- **Date:** 2026-11-10
- **Status:** accepted 2026-11-10 (Phil: GoCardless sandbox made; cards later; "option A"). The assumptions marked below confirmed by Phil 2026-11-11 ("yes, yes, yes"; "waive under 1 quid")
- **Code:** `packages/shared/src/plans.ts`, `apps/api/src/core/billing.ts`, `apps/api/src/core/usage.ts`, `apps/api/src/providers/payments.ts`

## 1. What's decided

1. **Direct Debit through GoCardless, cards later.** The plan's default. A business authorises a mandate once, on GoCardless's hosted page, and each month's charge is collected against it. Stripe cards are not built now: one payment route is enough for the first customers, and can be added when someone actually refuses Direct Debit.
2. **This system bills the AnswerMate plan only** (the plan's option A). A business's Direct Debit covers its AnswerMate plan. Anything else the reseller sells alongside it, the reseller invoices himself; this system never knows about it. No bundle plan is modelled.
3. **Billing periods are months on the anniversary of going live**, not calendar months and not 30-day windows. A business that goes live on the 14th has periods from the 14th to the 13th, is charged once a month, and its included minutes are a month's worth from day one (no pro-rata first month, which included minutes make messy). A go-live on the 31st falls back to the last day of shorter months, the way Temporal's month arithmetic does. Appendix D's "rolling 30-day contract" is read as the notice term, not the billing cycle: twelve charges a year, not thirteen.
4. **The pilot** is Appendix D's: the first month free, then £49 a month for three months, then the full plan. Overage is charged in every month, the free one included: the free month waives the plan fee, not usage beyond the included minutes. (Confirmed by Phil 2026-11-11; easy to change in `plans.ts`.)
5. **Everything in `plans.ts` is data:** the plan's price, included minutes, overage rate and the pilot's shape, so a price change is an edit, not a rebuild. VAT is off until `VAT_REGISTRATION` (number and effective date) is set; from that date, 20% is added to each charge, rounded once on the subtotal.
6. **No automatic cut-off** (the plan's rule): a failed payment alerts and notifies, and never suspends. Suspension stays a button.
7. **Charged in arrears, the morning after each month ends** (06:00 UK), for every month that has ended and isn't charged yet, so a missed morning catches up. Added with charging (2026-11-10):
   - **Test businesses never pay**, like the demo line: a business from a test link is Phil trying the service. (Confirmed 2026-11-11.)
   - **A business that leaves is charged for the month it left in**, and none after: a month that began before it asked to leave is charged in full, one that began on or after isn't. (Callers hear "service has ended" from the moment it asks, so there's a case for charging that month pro rata instead.) (Confirmed 2026-11-11.)
   - **A suspended business isn't charged for a month it spent suspended from start to end** (Phil, 2026-11-11). Any month with some service in it is charged in full: the month the suspension began in, and the month it was resumed in. Measured from UK midnight at the month's start to UK midnight at its end, against each suspension's start and end (`tenant_suspensions`, written by the admin's suspend and resume). Such a month is recorded as nothing due, with the line "Suspended for the whole month: no charge". Why not charge: there's no service to charge for, and the Direct Debit Guarantee lets a customer reclaim a payment from their bank straight away, so a charge for nothing would likely come back as a chargeback anyway. Why charge the resumed month in full rather than pro rata: the leaving rule already charges whole months, and pro rata would be the only part-month sum in the system. What was owed before the suspension is still owed. Options considered: keep charging (the status quo: discarded, charging for no service invites complaints and chargebacks); skip any month that _starts_ suspended (discarded: resuming on the 2nd would give that month free); pro rata (discarded, above). Confidence: high that it's fair; the terms should say it (solicitor). Strongest case against: a business suspended for not paying gets free months while it sorts it out, though it gets no service in them either.
   - **A £0 month** (a pilot's free month inside its minutes, or one suspended throughout) is recorded but sends no payment and no email.
   - **A failed payment isn't collected again automatically**: the business is emailed and Phil alerted; collecting it again is a button on the Admin page (**Collect again**: GoCardless's own retry of the same payment), and the charge follows it through to paid.
   - **A month owing less than £1** (GoCardless's Bacs minimum: a pilot's free month a few minutes over) is recorded and not collected: waived. (Confirmed 2026-11-11: waived rather than carried into the next month.)
   - **No call before the day a business goes live is billed**, the test call included (BUILD_PLAN Step 12: test calls excluded). A call the same day it goes live counts.
8. **Only the bank failing a payment is the customer's payment failing.** A Direct Debit GoCardless won't collect from is ended here too and the month waits for a new one; anything else GoCardless refuses (a wrong token, a malformed request) fails the morning's run so it's retried, then dead-lettered with an alert, and the business is told nothing. (From the review of 2026-11-10.)
9. **Known edge, accepted:** a call that reaches us after 06:00 on the morning after its month ended (a late webhook) adds to a month already charged, and isn't billed.

## 2. Options

| Option                                      | Why not                                                                                                                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GoCardless Direct Debit first (chosen)**  | (chosen): the plan's default; monthly UK business subscriptions are what it's for; nothing expires                                                               |
| Stripe cards now as well                    | A second provider to build, test and reconcile before there's a customer. Later, if asked for                                                                    |
| Stripe only                                 | Cards expire, get replaced and fail more for monthly business charges; Direct Debit's fees are lower                                                             |
| Calendar months with a pro-rata first month | Pro-rating the fee is easy; pro-rating 200 included minutes isn't, and "£99 a month" on the same date each month is what the customer expects                    |
| Rolling 30-day periods                      | Thirteen charges a year; the date drifts; customers notice                                                                                                       |
| Billing bundles here                        | The system would model the reseller's other products, their VAT and his share of each payment; every new thing he sells becomes a change to this code (option B) |

## 3. Confidence and the case against

- **High** on Direct Debit first and on billing only this plan. **Medium-high** on anniversary months: it's the cleanest for the customer, at the cost of per-business period anchors in the usage code (done: `billing_start_date`, set the moment a business goes live).
- **The strongest case against:** anniversary billing means every business has its own charge date, so "end of period" is a nightly job finding yesterday's period ends rather than one run on the 1st. That's a few lines, and it's what the plan's "end of period" step already implies.
- **Revisit** if a customer asks to be billed on a fixed date (an easy per-business anchor change), or if cards are needed.

Docs read 2026-11-10: [GoCardless API reference](https://docs.gocardless.com/api-reference/) (making requests, billing requests and flows, payments, webhooks, scenario simulators, limits).
