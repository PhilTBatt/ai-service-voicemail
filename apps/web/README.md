# @callmate/web

The AnswerMate dashboard: React 19, built and served by Vite, with Clerk for login (decision 012)
and its own design system (decision 020; the whole picture is in `docs/UI.md`).

- `src/main.tsx` starts the app: the design system's styles, Clerk, the router, toasts and
  dialogs.
- `src/App.tsx` the routes: Clerk's sign-in when signed out, the pages when signed in.
- `src/shell/` the frame: the sidebar (a drawer on a phone) and what it offers each person
  (`nav.ts`).
- `src/design/` the design system: tokens, base styles, components, patterns, icons, dialogs,
  toasts, the colour theme.
- `src/tenant-layout.tsx` loads one business for all its pages, with its header.
- `src/pages/` the screens. `src/ui.tsx` AnswerMate's own pieces (urgency and status badges).
- `src/api.ts` calls the API at `/api` with the Clerk session token as a bearer token.
- `src/time.ts` UK time: stored as UTC, shown in Europe/London.

The API decides what each person may see. Hiding a link here is a convenience, never security.

Run it from the repo root, with the API running (`npm run dev`):

```powershell
npm run dev:web
```

then open http://localhost:5173. Settings come from the root `.env`; only `CLERK_PUBLISHABLE_KEY`
reaches the browser.
