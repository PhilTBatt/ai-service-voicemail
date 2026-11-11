// One business's onboarding checklist, for the admin: every step and where the business is,
// what the system can see, the pilot switch, and a button to move on to the next step when its
// condition holds. The API decides; this page shows its answer, and its reason when it says no.
import type { OnboardingView } from "@callmate/shared";
import { useState } from "react";
import { asError, useApi, useLoad } from "../api.ts";
import { useTenant } from "../tenant-layout.tsx";
import { ErrorNote } from "../ui.tsx";

export function OnboardingPage() {
  const { tenant, reload } = useTenant();
  const { api } = useApi();
  const onboarding = useLoad(
    () => api<OnboardingView>(`/admin/tenants/${tenant.id}/onboarding`),
    tenant.id,
  );

  if (onboarding.status === "loading") return <p className="muted">Loading…</p>;
  if (onboarding.status === "error") {
    return <ErrorNote error={onboarding.error} retry={onboarding.reload} />;
  }
  return (
    <div className="legacy">
      <Checklist key={tenant.id} tenantId={tenant.id} initial={onboarding.data} onLive={reload} />
    </div>
  );
}

function Checklist({
  tenantId,
  initial,
  onLive,
}: {
  tenantId: string;
  initial: OnboardingView;
  onLive: () => void;
}) {
  const { api } = useApi();
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const run = async (request: () => Promise<OnboardingView>) => {
    setBusy(true);
    setError(null);
    try {
      const updated = await request();
      setView(updated);
      if (updated.state === "live") onLive(); // the header's status changes too
    } catch (caught) {
      setError(asError(caught));
    } finally {
      setBusy(false);
    }
  };
  const advance = (to: string) =>
    run(() =>
      api<OnboardingView>(`/admin/tenants/${tenantId}/onboarding/advance`, {
        method: "POST",
        body: { to },
      }),
    );
  const [divertQueued, setDivertQueued] = useState(false);
  const textDivertInstructions = async () => {
    setBusy(true);
    setError(null);
    try {
      await api<{ queued: true }>(`/admin/tenants/${tenantId}/onboarding/divert-instructions`, {
        method: "POST",
        body: {},
      });
      setDivertQueued(true);
    } catch (caught) {
      setError(asError(caught));
    } finally {
      setBusy(false);
    }
  };
  const setPilot = (pilot: boolean) =>
    run(() =>
      api<OnboardingView>(`/admin/tenants/${tenantId}/pilot`, { method: "PUT", body: { pilot } }),
    );

  return (
    <>
      <section className="card">
        <h2>Onboarding</h2>
        <ol className="steps">
          {view.steps.map((step) => (
            <li
              key={step.state}
              className={step.state === view.state ? "current" : step.done ? "done" : ""}
            >
              {step.done ? "✓ " : ""}
              {step.label}
            </li>
          ))}
        </ol>
        {view.next ? (
          <div className="save-bar">
            <button
              type="button"
              disabled={busy || !view.next.allowed}
              onClick={() => {
                const { state, label } = view.next!;
                const warning =
                  state === "live"
                    ? "Take this business live? Its number starts answering calls with the assistant."
                    : `Move this business on to "${label}"?`;
                if (window.confirm(warning)) void advance(state);
              }}
            >
              Move on to: {view.next.label}
            </button>
            {view.next.reason && <span className="muted">Not yet: {view.next.reason}.</span>}
          </div>
        ) : (
          <p className="notice card ok">This business is live.</p>
        )}
        {error && <ErrorNote error={error} />}
      </section>

      <section className="card">
        <h2>Divert instructions</h2>
        <p className="hint">
          Texts the tradesperson the codes for their network, with a link to the Phone setup page.
          Once it's sent, a business at "Assistant set up" moves on by itself; then its first call
          moves it to "Test call received", and it goes live when the rule allows.
        </p>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => void textDivertInstructions()}
        >
          Text the divert instructions
        </button>
        {divertQueued && (
          <p className="muted">
            Queued: the worker sends it within a few seconds while it's running.
          </p>
        )}
      </section>

      <section className="card">
        <h2>What the system can see</h2>
        <ul className="checks">
          {view.checks.map((check) => (
            <li key={check.label} className={check.ok ? "ok" : ""}>
              {check.ok ? "✓" : "✗"} {check.label}
            </li>
          ))}
        </ul>
        <label className="check">
          <input
            type="checkbox"
            checked={view.isPilot}
            disabled={busy}
            onChange={(event) => void setPilot(event.target.checked)}
          />
          Pilot: free, so it can go live before billing exists
        </label>
      </section>
    </>
  );
}
