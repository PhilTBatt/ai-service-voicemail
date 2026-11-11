// The dashboard's frame: Clerk's sign-in page when signed out; when signed in, who we are to
// the API (GET /api/me), the shell (sidebar and navigation), and the pages that person may
// open. What each page may show is the API's decision, not this file's: hiding a link here is
// convenience, never security.
//
// The pages about one business sit under TenantLayout, which loads the business once for all
// of them (tenant-layout.tsx). A new page is a route here and an entry in shell/nav.ts.
import type { MeView } from "@callmate/shared";
import { Show, SignIn } from "@clerk/react";
import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { ApiError, useApi, useLoad } from "./api.ts";
import { EmptyState, ErrorNote, Loading } from "./design/components.tsx";
import { ErrorBoundary } from "./design/error-boundary.tsx";
import { Ban, Inbox } from "./design/icons.ts";
import { CallPage } from "./pages/CallPage.tsx";
import { PhonePage } from "./pages/PhonePage.tsx";
import { ProfilePage } from "./pages/ProfilePage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { TenantPage } from "./pages/TenantPage.tsx";
import { TenantsPage } from "./pages/TenantsPage.tsx";
import { AppShell, Brand } from "./shell/AppShell.tsx";
import { TenantLayout } from "./tenant-layout.tsx";

// Pages only Phil (or a new signup) opens are loaded when they're opened, as separate files, so
// a tradesperson's phone never downloads them. `lazy` wants a default export; these name theirs.
const AdminLayout = lazy(() =>
  import("./pages/admin/AdminLayout.tsx").then((m) => ({ default: m.AdminLayout })),
);
const AdminOverview = lazy(() =>
  import("./pages/admin/AdminOverview.tsx").then((m) => ({ default: m.AdminOverview })),
);
const AdminBilling = lazy(() =>
  import("./pages/admin/AdminBilling.tsx").then((m) => ({ default: m.AdminBilling })),
);
const AdminLeaving = lazy(() =>
  import("./pages/admin/AdminLeaving.tsx").then((m) => ({ default: m.AdminLeaving })),
);
const AdminUsage = lazy(() =>
  import("./pages/admin/AdminUsage.tsx").then((m) => ({ default: m.AdminUsage })),
);
const DesignGallery = lazy(() =>
  import("./pages/admin/DesignGallery.tsx").then((m) => ({ default: m.DesignGallery })),
);
const OnboardingPage = lazy(() =>
  import("./pages/OnboardingPage.tsx").then((m) => ({ default: m.OnboardingPage })),
);
const SignupPage = lazy(() =>
  import("./pages/SignupPage.tsx").then((m) => ({ default: m.SignupPage })),
);

/** Every page, except the signup page, which someone with no account yet must be able to use. */
export function App() {
  const { pathname } = useLocation();
  if (pathname === "/signup") {
    return (
      <ErrorBoundary>
        <Suspense fallback={<Loading />}>
          <SignupPage />
        </Suspense>
      </ErrorBoundary>
    );
  }
  return (
    <>
      <Show when="signed-out">
        <main className="auth">
          <div className="auth-intro">
            <Brand />
            <p className="auth-tagline">
              Your calls, answered. Sign in to see who rang and what they needed.
            </p>
          </div>
          <SignIn />
          <p className="auth-footer">AnswerMate, by Brockersby</p>
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
    <AppShell me={me.status === "ready" ? me.data : null}>
      {me.status === "loading" && <Loading />}
      {me.status === "error" && <MeError error={me.error} retry={me.reload} />}
      {me.status === "ready" && (
        <ErrorBoundary>
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route path="/" element={<Home me={me.data} />} />
              <Route path="/tenants/:tenantId" element={<TenantLayout me={me.data} />}>
                <Route index element={<TenantPage />} />
                <Route path="profile" element={<ProfilePage />} />
                <Route path="phone" element={<PhonePage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="onboarding" element={<OnboardingPage />} />
                <Route path="calls/:callId" element={<CallPage />} />
              </Route>
              <Route path="/admin" element={<AdminLayout />}>
                <Route index element={<AdminOverview />} />
                <Route path="billing" element={<AdminBilling />} />
                <Route path="leaving" element={<AdminLeaving />} />
                <Route path="usage" element={<AdminUsage />} />
                <Route path="design" element={<DesignGallery />} />
              </Route>
              <Route
                path="*"
                element={
                  <div className="card">
                    <EmptyState icon={Inbox} headingLevel={1} title="There's no page here">
                      The address may be mistyped, or the page has moved.
                    </EmptyState>
                  </div>
                }
              />
            </Routes>
          </Suspense>
        </ErrorBoundary>
      )}
    </AppShell>
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
      <div className="card">
        <EmptyState icon={Ban} headingLevel={1} title="This address hasn't been invited">
          You're signed in, but AnswerMate has no account for this email address. Sign out (bottom
          of the menu) and sign in with the address your invitation went to, or ask for an
          invitation.
        </EmptyState>
      </div>
    );
  }
  return <ErrorNote error={error} retry={retry} />;
}
