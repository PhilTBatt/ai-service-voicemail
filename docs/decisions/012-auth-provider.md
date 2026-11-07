# 012: Login provider for the dashboard (Step 10 gate)

- **Date:** 2026-11-08
- **Status:** proposed. 🛑 Phil picks and creates the account.
- **Code:** `apps/api/src/providers/auth.ts` (the seam and fake, provider-neutral). The adapter follows the pick.

## 1. What login is for

Three kinds of people sign in to the dashboard: tradespeople (`owner`, their own tenant), Phil (`admin`, everything), and Ant (`reseller`, tenant list and billing status, never call content). Tradespeople won't manage a password well on a phone in a van, so the plan asks for **magic links** (or an emailed code) and Google sign-in. The API only needs to know, per request, who the caller is: a stable subject ID and an email. Roles and tenant membership stay in our database.

What the provider holds about a user is just name and email. Call content never goes near it.

## 2. What matters

1. Magic link or email code and Google, without paying for them.
2. A React component set that gives a decent sign-in page without building one.
3. A way for Express to verify the session cheaply (a JWT checked against the provider's public keys, with no call-out per request).
4. Price at 10 to 500 users, and what happens at 5,000.
5. Where user records live, and a DPA without paperwork.
6. Effort for one developer.

## 3. The candidates

Facts read on 2026-11-08 from the pages linked. Prices in US dollars as published.

|                         | Clerk                                                                                      | Microsoft Entra External ID                                                                            | Auth0                                                     | Supabase Auth                                                                                   | WorkOS AuthKit                                               |
| ----------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Free tier               | 50,000 monthly retained users; email codes, magic links and up to 3 social logins included | First 50,000 monthly active users free                                                                 | 25,000 monthly active users; passwordless included        | 50,000 monthly active users, but the project pauses after a week idle                           | First 1,000,000 monthly active users free                    |
| Next tier               | Pro $25 a month; overage $0.02 per user above 50,000                                       | Per-user price above 50,000 not shown on the page                                                      | Essentials from $35 a month for 500 users                 | Pro $25 a month, 100,000 users, then $0.00325 each                                              | $2,500 a month per extra million                             |
| Magic link / email code | Both, free                                                                                 | Email one-time passcode                                                                                | Passwordless, free                                        | Magic link and email OTP (in the docs; not on the pricing page)                                 | "Magic auth", free                                           |
| Google sign-in          | Free                                                                                       | Via Google federation                                                                                  | Free                                                      | Free                                                                                            | Social login, free                                           |
| React                   | Drop-in components and hooks, the best in the field                                        | MSAL for React: works, more wiring                                                                     | React SDK                                                 | JS client                                                                                       | AuthKit hosted pages                                         |
| Express verification    | Clerk's Express package verifies the session JWT locally                                   | Standard JWT validation against Microsoft's JWKS                                                       | `express-oauth2-jwt-bearer`                               | JWT with the project secret                                                                     | Node SDK                                                     |
| Data location           | Not stated; GDPR compliance statement and DPA, no EU region option found                   | Microsoft's own regions; a "Go-Local" add-on for Australia or Japan only; no UK option stated          | Not stated on the pricing page                            | Project region is chosen at creation (London available for projects; not stated for Auth alone) | Not stated                                                   |
| Catch                   | US-hosted user records                                                                     | The heaviest setup; the consumer product replaced Azure AD B2C in 2025 and the docs are still settling | The $35 jump at 25,001 users and the most expensive curve | Tied to a Supabase project; running Auth against our own Postgres isn't a documented path       | Pricing built for enterprise; the free tier is a loss leader |

Self-hosting: Lucia is deprecated (March 2025). Better Auth is the live option (MIT, magic link and Google plugins, Postgres via its own adapter, announced it is joining Vercel). It would keep user records in our UK database, at the cost of owning the sign-in pages, email delivery of the links, session security and every future feature ourselves.

Sources: [Clerk pricing](https://clerk.com/pricing), [Clerk docs](https://clerk.com/docs), [Entra External ID overview](https://learn.microsoft.com/en-us/entra/external-id/customers/overview-customers-ciam), [Entra External ID pricing](https://www.microsoft.com/security/pricing/microsoft-entra-external-id/), [Auth0 pricing](https://auth0.com/pricing), [Supabase pricing](https://supabase.com/pricing), [WorkOS pricing](https://workos.com/pricing), [Lucia](https://lucia-auth.com/), [Better Auth](https://better-auth.com/).

## 4. Cost at our scale

At 10, 100 or 500 users every hosted option is **£0**. Clerk charges nothing until 50,000 retained users, Entra nothing until 50,000 active, Auth0 nothing until 25,000. The first money changes hands around 25,000 to 50,000 users, which is a different business from this one. Price doesn't decide it.

## 5. Recommendation: Clerk

**Why.** It does exactly what the plan asks on its free tier (magic links, email codes, Google), its React components mean the sign-in page, the user menu and the "which business am I in" switcher need no building, and its Express package verifies sessions locally. It's the least effort by a clear margin, and effort is the scarce thing here.

**Why not Entra External ID.** It's the plan's other named candidate and it sits next to our Azure hosting, which is appealing. Against: it's the most configuration (tenant, user flows, app registrations, MSAL on the front end), its consumer offering was reorganised in 2025 and the documentation shows it, and it offers no UK data location either, so the one thing that might have justified the effort isn't there.

**Why not the rest.** Auth0 costs more sooner for nothing extra. Supabase Auth wants its own project and database beside ours. WorkOS is aimed at enterprise SSO. Better Auth keeps data in the UK but makes us the security team for login, which is the wrong place to spend a solo developer's time before launch.

**Confidence:** medium-high.

**Strongest case against.** User names and emails sit with a US company. For a UK service that's a line in the privacy notice and a DPA, which Clerk provides; the call content, which is the sensitive data, never leaves our database. If Phil wants every byte in the UK, Better Auth is the answer and costs about a week.

## 6. What the code assumes

The seam built alongside this record asks the provider for one thing: given a bearer token, who is this (a stable subject ID and an email)? Everything else, roles, tenant membership and the reseller's blindfold, lives in our tables and is enforced in our middleware, so the provider can be swapped without touching the rest.
