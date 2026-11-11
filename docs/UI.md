# The dashboard's design: system, screens and plan

How AnswerMate's dashboard looks and is built, what each screen shows now and will show later,
and the rules for adding to it so it stays one product as it grows. Decision 020 records why it's
built this way. The code is in `apps/web/src/design/` (the system), `apps/web/src/shell/` (the
frame) and `apps/web/src/pages/` (the screens).

## 1. Principles

1. **A phone first, on a job.** The tradesperson reads the dashboard on a mobile with dirty hands
   and two minutes spare. The most-used thing (who rang, and ringing them back) is one tap. Text
   is never smaller than 14px, inputs never under 16px (iPhones zoom in on smaller ones), and
   tap targets are at least 40px.
2. **Calm until it matters.** Colour carries meaning, never decoration. Red is an emergency or
   something final, amber is urgent or needs a look, green is done or healthy. A page that's all
   fine is mostly white or grey, so a red card stands out.
3. **Plain British English.** "Switched off", not "paused"; "Answering", not "live". Say what
   happens ("Callers go to voicemail"), not what the system calls it. No jargon on a
   tradesperson's screen. Phil's Admin screens may be technical.
4. **Ask before anything that matters.** Anything that stops calls being answered, costs money
   or can't be undone goes through a dialog that says what will happen. Final things need a word
   or name typed first.
5. **One way to do each thing.** One button, one card, one list row, one way to show an error.
   A new screen is made from the same pieces, so it looks finished on day one.
6. **Everyone can use it.** WCAG 2.2 AA: colour contrast, keyboard, screen readers, reduced
   motion. Every icon has words beside it, or a label for screen readers.
7. **The API decides, the page shows.** Hiding a link is a convenience, never security. The
   reseller never sees call content, whatever the page does.

## 2. Who uses it, and for what

| Who                           | Role                 | Mostly on | Their jobs                                                                                                                            |
| ----------------------------- | -------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Tradesperson                  | `owner`              | Phone     | See who rang and ring back; mark calls dealt with; switch off for a holiday; set what the assistant says; set up diverts; pay; leave. |
| Phil                          | `admin`              | Laptop    | Keep the service healthy; review flagged calls; set businesses up and take them live; sort billing problems; offboard.                |
| Ant (reseller)                | `reseller`           | Laptop    | Sign businesses up; see how many calls each gets. **Never call content** (CLAUDE.md).                                                 |
| Later: a tradesperson's staff | `member` (not built) | Phone     | See and ring back calls; nothing about billing or leaving.                                                                            |

## 3. The screens

### Now

| Address                      | Screen                 | Who                                     | What it shows                                                                                                                                                                                      |
| ---------------------------- | ---------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                          | Businesses             | admin, reseller, owner with two or more | Totals (businesses, answering, setting up, calls in 30 days); signup links; every business with status, trade, onboarding step, billing summary, calls. A tradesperson with one business skips it. |
| `/tenants/:id`               | Calls                  | admin, owner                            | Answering on or off (and the switch); the calls by UK day, filtered by urgency, "needs a reply" and dates.                                                                                         |
| `/tenants/:id/calls/:callId` | A call                 | admin, owner                            | Who, when, how long, urgency, flags; Call back; Called back; summary, transcript, details, recording.                                                                                              |
| `/tenants/:id/profile`       | Assistant              | admin, owner                            | Trade and services, areas, opening hours, holiday, urgent call-outs, FAQs; whether the assistant is using them yet.                                                                                |
| `/tenants/:id/phone`         | Phone setup            | admin, owner                            | The number; the divert codes for their network, with copy buttons; checking and testing; turning off.                                                                                              |
| `/tenants/:id/settings`      | Account                | admin, owner                            | The number (and buying one, admin); where messages go; plan, this month's minutes, Direct Debit, past months; suspension (admin); documents; data download; leaving.                               |
| `/tenants/:id/onboarding`    | Onboarding             | admin                                   | The steps, what the system can see, the divert text, the pilot switch.                                                                                                                             |
| `/admin`                     | Admin: Overview        | admin                                   | Health (kill switch, worker, the last day's failures, scheduled jobs); calls to review.                                                                                                            |
| `/admin/billing`             | Admin: Billing         | admin                                   | This month's money (collected, being collected, not collected); payments that need Phil, with Collect again.                                                                                       |
| `/admin/leaving`             | Admin: Leaving         | admin                                   | Businesses that cancelled: when their number can be released, and deleting their data.                                                                                                             |
| `/admin/usage`               | Admin: Usage and costs | admin                                   | Billable time per business this period; what each business's calls cost us this month.                                                                                                             |
| `/admin/design`              | Admin: Components      | admin                                   | The component gallery: every component in its states. Check a change to the system here, light and dark, before it reaches a screen.                                                               |
| `/signup?code=`              | Signup                 | anyone with a link                      | Sign in, then the business, phone and documents, each problem shown by its field.                                                                                                                  |

Outside the dashboard, the page behind a text's link (`apps/api/src/core/call-page.ts`: no script,
no login) uses the same colours, copied as values; `design/tokens.test.ts` checks they match.

The Admin pages, Onboarding and Signup are downloaded only when opened (`lazy` in `App.tsx`), so
a tradesperson's phone never fetches them.

### Later (not built; the information each will need)

Each line says what it needs that the API doesn't give yet. None of it is promised; it's here so
the design leaves room for it and nobody rebuilds a screen to fit it.

**For the tradesperson**

- **A home summary on Calls**: calls this week against last, how many still need a reply, the
  last emergency. Needs: counts by period and urgency (`GET /tenants/:id/stats`, new).
- **Search the calls** by name, number or postcode. Needs: a search query on the calls API
  (Postgres full-text on the summary and fields); the search box goes in the toolbar.
- **Repeat callers**: "Rang 3 times before", and a caller's history. Needs: calls grouped by
  caller number (a `callers` view); a link from the call page.
- **Notes on a call**: "Quoted £200, going Thursday". Needs: a `call_notes` table (tenant-scoped,
  RLS); shown on the call page under the summary. Never read by the assistant.
- **Text the caller back** from the call page ("I'll be there at 3"). Needs: a send-SMS route
  through the outbound allowlist, and a record of what was sent.
- **Which calls to be texted about**: emergencies only at night, say. Needs: notification rules
  per urgency and time (a settings table); a card on Account.
- **Quiet hours** for texts. Needs: the same rules.
- **Invoices as PDFs**, and changing card or plan. Needs: a receipt PDF route; plans beyond one.
- **A team**: staff who see calls but not billing. Needs: a `member` role, invitations from the
  owner, and per-role checks in the API. The sidebar's entries already come from one function
  (`shell/nav.ts`), so a role is a few lines there.
- **Notifications in the browser** (web push) for a new emergency. Needs: a service worker and
  push subscriptions; the dashboard as an installable app (manifest, icons).
- **Help**: a page of short answers and a way to reach Phil. Needs: content, not data.

**For Phil**

- **Business detail for admins**: one page with everything about a business (status history,
  messages sent, billing, audit log). Needs: the audit log and notifications by business
  (cross-tenant reads exist in `db/cross-tenant.ts`).
- **Money**: monthly recurring revenue, businesses joining and leaving, margin per business (the
  costs view minus the charge). Needs: aggregates over `billing_charges` and the costs view.
- **The assistant's quality**: eval results over time, flagged calls per week by reason, prompt
  versions and when each went live. Needs: eval reports stored, not only written to files.
- **Providers**: Retell, Twilio, Postmark, GoCardless and Anthropic health in one card (last
  success, last error). Needs: the alerts the API already raises, kept in a table.
- **Feature switches** per business (try a new prompt on one). Needs: a flags table.

**For Ant**

- **His businesses only, with counts**: signups this month, which are live, calls per business.
  Never call content: the API already refuses it, and any reseller screen is built on counts.

## 4. The design system

### Tokens (`design/tokens.css`)

Every colour, size, space, radius, shadow and timing has a name, and nothing else uses a raw
value. Colours are named for their job: `--color-surface`, `--color-text-muted`,
`--color-border`. Dark mode is the same names with other values, chosen by the person (the
switch at the bottom of the sidebar, remembered on that device) or followed from the device.
`design/tokens.test.ts` fails if anything uses a token that doesn't exist, if the two copies of
the dark values drift apart, or if a colour has no dark value.

- **Type**: the device's own font (Segoe UI, SF Pro, Roboto). Sizes 12 / 14 / 16 / 18 / 20 / 24 /
  30px. Headings semibold or bold, slightly tightened.
- **Space**: a 4px grid (`--space-1` is 4px, `--space-4` 16px, `--space-8` 32px).
- **Radius**: 6px small things, 10px buttons and inputs, 14px cards.
- **Breakpoints**: 40rem (640px: tables become stacked rows), 60rem (960px: the sidebar appears),
  70rem (1120px: the call page's second column appears).

### Tones

One idea used everywhere: a thing's **tone** says what it means, and the CSS picks the colours.

| Tone      | Means                                           | Examples                                           |
| --------- | ----------------------------------------------- | -------------------------------------------------- |
| `danger`  | An emergency; something final; something broken | Emergency calls, suspended, failed payment, Cancel |
| `warning` | Urgent; needs a look soon                       | Urgent calls, switched off, documents to accept    |
| `success` | Done; healthy                                   | Answering, called back, paid                       |
| `info`    | Neutral news; in progress                       | Routine calls, setting up, being collected         |
| `brand`   | Ours, or selected                               | The current page, the demo line                    |
| `neutral` | Nothing to say                                  | Spam, left, nothing due                            |

### Components (`design/components.tsx`)

| Component                                   | Use it for                                                                                                                                                                                                                  | Don't                                         |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `Button`, `ButtonLink`, `ButtonAnchor`      | Actions (`primary`: the one main action of a card; `secondary`: the others; `ghost`: small or repeated actions; `danger`: anything final; `link`: an undo inside text). `loading` shows a spinner and stops a double press. | Two primaries side by side.                   |
| `Card`                                      | A group of related things, with an optional icon, title, description, actions and footer (buttons go in the footer). `flush` for lists. `tone` for state.                                                                   | Cards inside cards.                           |
| `PageHeader`, `SectionHeader`               | A page's one h1; a part of a page with its own actions.                                                                                                                                                                     |                                               |
| `Badge`                                     | A short status beside something (`dot` for a state).                                                                                                                                                                        | Sentences.                                    |
| `Alert`                                     | Something to read: a problem, a warning, a confirmation that stays. Danger alerts are announced to screen readers.                                                                                                          | News that's gone in a moment (use a toast).   |
| `ErrorNote`                                 | An error from the API, with Try again.                                                                                                                                                                                      |                                               |
| Toast (`useToast`)                          | "Saved", "Copied": gone by itself in 5 seconds.                                                                                                                                                                             | Errors, or anything that needs reading.       |
| Dialog (`useConfirm`, `useConfirmTyped`)    | Asking before anything that stops calls, costs money or can't be undone.                                                                                                                                                    | Asking "Are you sure?" about something small. |
| `TextField`, `TextAreaField`, `SelectField` | Every input: label, optional hint, errors, all wired for screen readers.                                                                                                                                                    | A bare `<input>`.                             |
| `Checkbox`, `Switch`, `RadioGroup`          | A yes/no to agree to (Checkbox); a setting that's on or off (Switch); one of a few, with words (RadioGroup).                                                                                                                |                                               |
| `Tabs`                                      | Links across the top of a section's pages (Admin). Marks the current one.                                                                                                                                                   | The main navigation (that's the sidebar).     |
| `Segmented`, `ToggleChip`                   | Filters above a list.                                                                                                                                                                                                       | Settings that are saved.                      |
| `Stat`, `Meter`                             | A number that matters; how much of something is used.                                                                                                                                                                       |                                               |
| `DescriptionList`                           | Label and value pairs.                                                                                                                                                                                                      |                                               |
| `Avatar`                                    | Initials, coloured by tone.                                                                                                                                                                                                 | Photos (we have none).                        |
| `EmptyState`, `Loading`                     | Nothing to show yet (with what will appear and how); grey bars while it loads.                                                                                                                                              | A bare "No results".                          |
| `CopyCode`                                  | A code to dial or copy.                                                                                                                                                                                                     |                                               |

AnswerMate's own pieces built from these are in `ui.tsx` (`UrgencyBadge`, `StatusBadge`,
`BrandMark`). The design system knows nothing about calls; `ui.tsx` does.

### Patterns (`design/patterns.css`)

Arrangements more than one screen uses: a business's header, the answering switch, the toolbar
of filters, the call list grouped by day, the transcript as chat bubbles, form sections with a
save bar that stays on screen, opening hours, the danger zone. Layout helpers in `base.css`:
`stack` (down the page), `cluster` (along a line that wraps), `grid` (columns that fold to one),
`split` (a main column and a narrower one).

### The frame (`shell/`)

`AppShell` is the sidebar (brand, navigation, colour switch, who's signed in) and the page. On a
phone the sidebar is a drawer behind a menu button. **There is one navigation**, and what it
offers comes from `navSections()` in `shell/nav.ts`, tested in `nav.test.ts`. Pages about one
business sit inside `TenantLayout` (`tenant-layout.tsx`), which loads the business once, shows
its header and the documents reminder, and hands the business to the page (`useTenant()`).

## 5. Rules for adding to it

**A new page**

1. A route in `App.tsx` (under `TenantLayout` if it's about one business).
2. An entry in `shell/nav.ts`, with a test in `nav.test.ts`, if it belongs in the sidebar.
3. Built from components and patterns only. If it needs something they don't do, add a
   component (or pattern) with a name, rather than styling the page. Pages have no CSS of their
   own and no `style={{}}` (a component may set a computed width).
4. Its loading, empty and error states, each with a component (`Loading`, `EmptyState`,
   `ErrorNote`).
5. Checked at 390px wide and in dark mode before it's done.
6. A browser test (`apps/web/e2e/`) for its main job, finding things by role and label the way a
   person would. Keep each label unique on its page: tests (and screen readers) find things by it.

**A new component**

1. In `components.tsx` (or its own file in `design/` if it's large, like the dialog), styled in
   `components.css` with tokens only.
2. Optional props typed `?: X | undefined` (the project's strict TypeScript needs it).
3. Accessible by default: a label, the right role, the keyboard working.
4. A row in the table above, and a place in the gallery (`pages/admin/DesignGallery.tsx`).

**A new colour or size**: a token in `tokens.css` with a dark value; the tokens test checks it.

**Copy**: plain British English, sentence case, no exclamation marks. Buttons say what they do
("Switch off", not "OK"). Errors say what happened and what to do.

## 6. Testing

- **Unit** (Vitest, no browser): the pure functions the pages use (`format.ts`, `time.ts`,
  `calls-query.ts`, `profile-form.ts`, `shell/nav.ts`) and the tokens.
- **Browser** (Playwright, `npm run e2e`): the real dashboard against the real API and test
  database, sign-in stubbed. Every main job has one.
- **Later**: screenshot comparisons (Playwright's `toHaveScreenshot`) of the gallery, so a change
  to a token shows everywhere it lands; and automated accessibility checks (axe) on each page.

## 7. Changing the look later

- **A rebrand** (new colours, a new font): edit `tokens.css` (and the copied values in
  `call-page.ts`, which the tokens test checks), then look at the gallery in light and dark.
- **A bigger redesign of one part**: the way this one was done (2026-11-11). Pages not yet moved
  sat in a `.legacy` wrapper, with a stylesheet drawing their old class names in the new tokens,
  scoped so it couldn't reach a rebuilt page; it was deleted with the last of them. Do the same:
  never two half-finished looks without a wall between them.
- **Something the components can't do** (a date-range picker, a searchable list): decision 020
  says the next step is a headless library (Radix) for that one thing, styled with these tokens.
