# @callmate/web

The AnswerMate dashboard: React 19, built and served by Vite, with Clerk for login (decision 012).

- `src/main.tsx` starts the app inside Clerk's provider and the router.
- `src/App.tsx` shows Clerk's sign-in page when signed out, and the pages when signed in.
- `src/api.ts` calls the API at `/api` with the Clerk session token as a bearer token.
- `src/pages/` the business list, one business's calls, and one call.
- `src/time.ts` UK time: stored as UTC, shown in Europe/London.

The API decides what each person may see. Hiding a link here is a convenience, never security.

Run it from the repo root, with the API running (`npm run dev`):

```powershell
npm run dev:web
```

then open http://localhost:5173. Settings come from the root `.env`; only `CLERK_PUBLISHABLE_KEY`
reaches the browser.
