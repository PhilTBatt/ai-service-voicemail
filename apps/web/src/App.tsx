// The dashboard's frame: Clerk's sign-in page when signed out; when signed in, who we are to
// the API (GET /api/me) and the pages that person may open. What each page may show is the
// API's decision, not this file's: hiding a link here is convenience, never security.
import type { MeView } from "@callmate/shared";
import { Show, SignIn, UserButton } from "@clerk/react";
import { Link, Navigate, Route, Routes } from "react-router";
import { ApiError, useApi, useLoad } from "./api.ts";
import { AdminPage } from "./pages/AdminPage.tsx";
import { CallPage } from "./pages/CallPage.tsx";
import { ProfilePage } from "./pages/ProfilePage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { TenantPage } from "./pages/TenantPage.tsx";
import { TenantsPage } from "./pages/TenantsPage.tsx";
import { ErrorNote } from "./ui.tsx";

export function App() {
  return (
    <>
      <Show when="signed-out">
        <main className="sign-in">
          <h1 className="brand">AnswerMate</h1>
          <SignIn />
        </main>
      </Show>
      <Show when="signed-in">
        <SignedIn />
      </Show>
    </>
  );
}

function SignedIn() {
  const { api } = useApi();
  const me = useLoad(() => api<MeView>("/me"), "me");

  return (
    <>
      <header className="top-bar">
        <Link to="/" className="brand">
          AnswerMate
        </Link>
        <nav className="top-nav">
          {me.status === "ready" && me.data.role === "admin" && <Link to="/admin">Admin</Link>}
          <UserButton />
        </nav>
      </header>
      <main className="page">
        {me.status === "loading" && <p className="muted">Loading…</p>}
        {me.status === "error" && <MeError error={me.error} retry={me.reload} />}
        {me.status === "ready" && (
          <Routes>
            <Route path="/" element={<Home me={me.data} />} />
            <Route path="/tenants/:tenantId" element={<TenantPage me={me.data} />} />
            <Route path="/tenants/:tenantId/profile" element={<ProfilePage me={me.data} />} />
            <Route path="/tenants/:tenantId/settings" element={<SettingsPage me={me.data} />} />
            <Route path="/admin" element={<AdminPage />} />
            <Route path="/tenants/:tenantId/calls/:callId" element={<CallPage />} />
            <Route path="*" element={<p>There's no page here.</p>} />
          </Routes>
        )}
      </main>
      <footer className="footer muted">Times are UK time.</footer>
    </>
  );
}

/** A tradesperson with one business goes straight to it; everyone else gets the list. */
function Home({ me }: { me: MeView }) {
  const only = me.role === "owner" && me.tenantIds.length === 1 ? me.tenantIds[0] : undefined;
  return only ? <Navigate to={`/tenants/${only}`} replace /> : <TenantsPage me={me} />;
}

function MeError({ error, retry }: { error: Error; retry: () => void }) {
  if (error instanceof ApiError && error.status === 403) {
    return (
      <section className="card">
        <h2>This address hasn't been invited</h2>
        <p>
          You're signed in, but AnswerMate has no account for this email address. Sign out from the
          menu at the top right and sign in with the address your invitation went to, or ask for an
          invitation.
        </p>
      </section>
    );
  }
  return <ErrorNote error={error} retry={retry} />;
}
