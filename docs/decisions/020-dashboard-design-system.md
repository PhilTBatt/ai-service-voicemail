# 020: The dashboard's design system

**Date:** 2026-11-11. **Status:** accepted (Phil asked for a full redesign: "sleek, modern yet
professional, adaptable as we keep adding").

## Decision

The dashboard is built on its own small design system, in plain CSS and React with no UI
framework:

1. **Design tokens** (CSS custom properties in `apps/web/src/design/tokens.css`) for every
   colour, size, space, radius, shadow and timing, named for their job, with a dark set.
2. **A small component set** (`design/components.tsx`, `dialog.tsx`, `toast.tsx`) and named
   patterns (`patterns.css`). Pages are made only of these.
3. **One navigation** (`shell/nav.ts`), drawn as a sidebar on a wide screen and a drawer on a
   phone.
4. **Icons from Lucide** (`lucide-react`, ISC licence), pinned to 1.61.0 (published 21 October
   2026, three weeks before this; the newest was a day old). Re-exported from one file
   (`design/icons.ts`), so the set stays small and can be swapped.
5. **The device's own font**: nothing downloaded.
6. **Dark mode**: follows the device, or the person's choice, remembered on that device only.
7. **Clerk's sign-in** coloured with the same tokens through its `appearance` variables, which
   accept CSS variables (Clerk's docs:
   https://clerk.com/docs/react/guides/customizing-clerk/appearance-prop/variables), so it
   follows light and dark with the page.

`docs/UI.md` has the system, the screens and the rules for adding to it.

## Options considered

- **Tailwind CSS.** Fast to write, popular, good defaults. Discarded: it puts styling in every
  page's markup, which is the opposite of "pages are made of named components", and it's a build
  dependency and a second language for Phil to read. Its design-token idea is what we kept.
- **A component library (MUI, Mantine, or shadcn/ui on Radix).** Many components for free,
  accessibility handled. Discarded: MUI and Mantine look like themselves and are heavy to
  restyle; shadcn copies a lot of code in and needs Tailwind. The dashboard needs about twenty
  components, and the browser's own `<dialog>` now does the hard part of a modal.
- **CSS-in-JS (styled-components, Emotion).** Discarded: styles worked out in the browser at
  run time, a dependency, and nothing it does that tokens and plain CSS don't here.
- **Hand-drawn icons.** Discarded: a consistent set of a hundred icons as features arrive is
  real work; Lucide is that, under a permissive licence.
- **A downloaded font (Inter).** Discarded for now: a download and a dependency for a small gain;
  the system fonts are modern on every device. One token (`--font-sans`) to change if wanted.

## Confidence

High that tokens plus a small component set suits a product this size and keeps new screens
consistent. Medium that it stays enough: if the dashboard grows complex widgets (date-range
pickers, comboboxes, data grids), a headless library such as Radix for just those would be the
next step, styled with these tokens.

## The strongest case against

We now own every component's accessibility: keyboard handling, focus, screen-reader roles. A
library like Radix has had thousands of people find its edge cases. Mitigations: the browser's
own elements wherever possible (`<dialog>`, `<input type="checkbox">` drawn as a switch,
`<select>`), the browser tests finding everything by role and label as a screen reader would,
and automated accessibility checks planned (UI.md section 6).
