// Stands in for @clerk/react in the browser smoke tests only: `vite --mode e2e` swaps it in
// (vite.config.ts), and nothing else imports it. Clerk's sign-in page can't run without a real
// Clerk account, so this offers a plain email box instead. Everything after sign-in is real: the
// pages, the API, the roles, the invitations and the database. The API side's stand-in is
// apps/api/src/testing/e2e-auth.ts, which reads the token this makes.
import { useState, type ReactNode } from "react";

const KEY = "e2e-signed-in";

function signedInToken(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** Stable across renders, like Clerk's. */
const getToken = (): Promise<string | null> => Promise.resolve(signedInToken());

export function ClerkProvider({
  children,
}: {
  children: ReactNode;
  publishableKey?: string;
  afterSignOutUrl?: string;
}) {
  return <>{children}</>;
}

export function Show({
  when,
  children,
}: {
  when: "signed-in" | "signed-out";
  children: ReactNode;
}) {
  const signedIn = signedInToken() !== null;
  return (when === "signed-in") === signedIn ? <>{children}</> : null;
}

export function SignIn() {
  const [email, setEmail] = useState("");
  return (
    <form
      className="card"
      onSubmit={(event) => {
        event.preventDefault();
        const person = { subject: `e2e_${email}`, email };
        window.localStorage.setItem(KEY, btoa(JSON.stringify(person)));
        window.location.reload();
      }}
    >
      <label className="stacked">
        Email
        <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
      </label>
      <button type="submit">Sign in</button>
    </form>
  );
}

export function UserButton() {
  return (
    <button
      type="button"
      className="secondary"
      onClick={() => {
        window.localStorage.removeItem(KEY);
        window.location.assign("/");
      }}
    >
      Sign out
    </button>
  );
}

export function useAuth() {
  return { getToken };
}
