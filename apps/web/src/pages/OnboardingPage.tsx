// One business's onboarding checklist, for the admin: every step and where the business is,
// what the system can see, the pilot switch, and a button to move on to the next step when its
// condition holds. The API decides; this page shows its answer, and its reason when it says no.
import type { OnboardingView } from "@callmate/shared";
import { useState } from "react";
import { asError, useApi, useLoad } from "../api.ts";
import {
  Alert,
  Button,
  Card,
  ErrorNote,
  Loading,
  SectionHeader,
  Switch,
} from "../design/components.tsx";
import { useConfirm } from "../design/dialog.tsx";
import {
  Check,
  CircleAlert,
  CircleCheck,
  ListChecks,
  MessageSquare,
  ShieldCheck,
} from "../design/icons.ts";
import { useToast } from "../design/toast.tsx";
import { useTenant } from "../tenant-layout.tsx";

export function OnboardingPage() {
  const { tenant, reload } = useTenant();
  const { api } = useApi();
  const onboarding = useLoad(
    () => api<OnboardingView>(`/admin/tenants/${tenant.id}/onboarding`),
    tenant.id,
  );

  return (
    <div className="stack stack-lg">
      <SectionHeader
        title="Onboarding"
        description="Admin only. Each step moves on when its condition holds; going live starts the number answering."
      />
      {onboarding.status === "loading" && <Loading label="Loading the checklist…" lines={5} />}
      {onboarding.status === "error" && (
        <ErrorNote error={onboarding.error} retry={onboarding.reload} />
      )}
      {onboarding.status === "ready" && (
        <Checklist key={tenant.id} tenantId={tenant.id} initial={onboarding.data} onLive={reload} />
      )}
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
  const confirm = useConfirm();
  const toast = useToast();
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [divertQueued, setDivertQueued] = useState(false);

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
  const advance = async () => {
    const { state, label } = view.next!;
    const yes = await confirm(
      state === "live"
        ? {
            title: "Take this business live?",
            body: "Its number starts answering calls with the assistant.",
            confirmLabel: "Go live",
          }
        : { title: `Move this business on to "${label}"?`, confirmLabel: "Move on" },
    );
    if (!yes) return;
    await run(() =>
      api<OnboardingView>(`/admin/tenants/${tenantId}/onboarding/advance`, {
        method: "POST",
        body: { to: state },
      }),
    );
  };
  const textDivertInstructions = async () => {
    setBusy(true);
    setError(null);
    try {
      await api<{ queued: true }>(`/admin/tenants/${tenantId}/onboarding/divert-instructions`, {
        method: "POST",
        body: {},
      });
      setDivertQueued(true);
      toast({ title: "Divert instructions queued" });
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
    <div className="split">
      <Card
        icon={ListChecks}
        title="Steps"
        footer={
          view.next ? (
            <div className="stack stack-sm">
              <div>
                <Button loading={busy} disabled={!view.next.allowed} onClick={() => void advance()}>
                  Move on to: {view.next.label}
                </Button>
              </div>
              {view.next.reason && <p className="muted text-sm">Not yet: {view.next.reason}.</p>}
            </div>
          ) : undefined
        }
      >
        <ol className="steps">
          {view.steps.map((step) => {
            const state = step.state === view.state ? "current" : step.done ? "done" : "upcoming";
            return (
              <li key={step.state} className="step" data-state={state}>
                <span className="step-marker">
                  {state === "done" && <Check size={14} strokeWidth={3} />}
                </span>
                <div className="step-body">
                  <p className="step-title">{step.label}</p>
                  {state === "current" && <p className="muted text-sm">Where it is now.</p>}
                </div>
              </li>
            );
          })}
        </ol>
        {!view.next && (
          <Alert tone="success">
            <p>This business is live.</p>
          </Alert>
        )}
        {error && <ErrorNote error={error} />}
      </Card>

      <div className="stack stack-lg">
        <Card icon={ShieldCheck} title="What the system can see">
          <ul className="check-list">
            {view.checks.map((check) => (
              <li key={check.label}>
                {check.ok ? (
                  <CircleCheck size={16} className="text-success" aria-hidden="true" />
                ) : (
                  <CircleAlert size={16} className="text-danger" aria-hidden="true" />
                )}
                <span>
                  <span className="sr-only">{check.ok ? "Yes: " : "Not yet: "}</span>
                  {check.label}
                </span>
              </li>
            ))}
          </ul>
          <Switch
            label="Pilot"
            description="Free, so it can go live before billing exists."
            checked={view.isPilot}
            disabled={busy}
            onChange={(event) => void setPilot(event.target.checked)}
          />
        </Card>

        <Card
          icon={MessageSquare}
          title="Divert instructions"
          description="Texts the tradesperson the codes for their network, with a link to the Phone setup page."
          footer={
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void textDivertInstructions()}
            >
              Text the divert instructions
            </Button>
          }
        >
          <p className="muted text-sm">
            Once it's sent, a business at "Assistant set up" moves on by itself; then its first call
            moves it to "Test call received", and it goes live when the rule allows.
          </p>
          {divertQueued && (
            <Alert tone="success">
              <p>Queued: the worker sends it within a few seconds while it's running.</p>
            </Alert>
          )}
        </Card>
      </div>
    </div>
  );
}
