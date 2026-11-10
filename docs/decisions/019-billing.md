# 019: Billing: Direct Debit first, monthly on the go-live anniversary, AnswerMate plans only (Step 12)

- **Date:** 2026-11-10
- **Status:** accepted 2026-11-10 (Phil: GoCardless sandbox made; cards later; "option A")
- **Code:** `packages/shared/src/plans.ts`, `apps/api/src/core/billing.ts`, `apps/api/src/core/usage.ts`, `apps/api/src/providers/payments.ts`

## 1. What's decided

1. **Direct Debit through GoCardless, cards later.** The plan's default. A business authorises a mandate once, on GoCardless's hosted page, and each month's charge is collected against it. Stripe cards are not built now: one payment route is enough for the first customers, and can be added when someone actually refuses Direct Debit.
2. **This system bills the AnswerMate plan only** (the plan's option A). A business's Direct Debit covers its AnswerMate plan. Anything else the reseller sells alongside it, the reseller invoices himself; this system never knows about it. No bundle plan is modelled.
3. **Billing periods are months on the anniversary of going live**, not calendar months and not 30-day windows. A business that goes live on the 14th has periods from the 14th to the 13th, is charged once a month, and its included minutes are a month's worth from day one (no pro-rata first month, which included minutes make messy). A go-live on the 31st falls back to the last day of shorter months, the way Temporal's month arithmetic does. Appendix D's "rolling 30-day contract" is read as the notice term, not the billing cycle: twelve charges a year, not thirteen.
4. **The pilot** is Appendix D's: the first month free, then £49 a month for three months, then the full plan. Overage is charged in every month, the free one included: the free month waives the plan fee, not usage beyond the included minutes. (Assumption for Phil to confirm; easy to change in `plans.ts`.)
5. **Everything in `plans.ts` is data:** the plan's price, included minutes, overage rate and the pilot's shape, so a price change is an edit, not a rebuild. VAT is off until `VAT_REGISTRATION` (number and effective date) is set; from that date, 20% is added to each charge, rounded once on the subtotal.
6. **No automatic cut-off** (the plan's rule): a failed payment alerts and notifies, and never suspends. Suspension stays a button.

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
