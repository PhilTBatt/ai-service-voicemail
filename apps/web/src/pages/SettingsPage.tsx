// The business's account: its number, where messages go, a download of everything we hold,
// and leaving.
import {
  notificationSettingsSchema,
  type CancellationView,
  type MeView,
  type NotificationSettings,
  type TenantView,
} from "@callmate/shared";
import { useState } from "react";
import { useParams } from "react-router";
import { asError, useApi, useLoad } from "../api.ts";
import { formatPhone, toUkMobileE164 } from "../format.ts";
import { NumberSection } from "../number-section.tsx";
import { TenantHeader } from "../tenant-header.tsx";
import { ukDate } from "../time.ts";
import { ErrorNote } from "../ui.tsx";

export function SettingsPage({ me }: { me: MeView }) {
  const { tenantId = "" } = useParams();
  const { api } = useApi();
  const tenant = useLoad(() => api<TenantView>(`/tenants/${tenantId}`), tenantId);

  if (tenant.status === "loading") return <p className="muted">Loading…</p>;
  if (tenant.status === "error") return <ErrorNote error={tenant.error} retry={tenant.reload} />;

  return (
    <>
      <TenantHeader me={me} tenant={tenant.data} />
      <NumberSection tenant={tenant.data} isAdmin={me.role === "admin"} onBought={tenant.reload} />
      <Notifications key={`n-${tenant.data.id}`} tenant={tenant.data} />
      <DataDownload tenantId={tenant.data.id} />
      <Cancel tenant={tenant.data} onCancelled={tenant.reload} />
    </>
  );
}

function Notifications({ tenant }: { tenant: TenantView }) {
  const { api } = useApi();
  const [mobile, setMobile] = useState(
    tenant.notificationMobile ? formatPhone(tenant.notificationMobile) : "",
  );
  const [email, setEmail] = useState(tenant.notificationEmail ?? "");
  const [problems, setProblems] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const save = async () => {
    setSaved(false);
    const candidate = {
      notificationMobile: mobile.trim() === "" ? null : toUkMobileE164(mobile),
      notificationEmail: email.trim() === "" ? null : email.trim(),
    };
    const checked = notificationSettingsSchema.safeParse(candidate);
    if (!checked.success) {
      setProblems(
        checked.error.issues.map(
          (issue) =>
            `${issue.path[0] === "notificationMobile" ? "Mobile" : "Email"}: ${issue.message}`,
        ),
      );
      return;
    }
    setProblems([]);
    setSaving(true);
    setError(null);
    try {
      await api<NotificationSettings>(`/tenants/${tenant.id}/notifications`, {
        method: "PUT",
        body: checked.data,
      });
      setSaved(true);
    } catch (caught) {
      setError(asError(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="card profile"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h2>Where your messages go</h2>
      <label className="stacked">
        Mobile, for texts about each call
        <input
          type="tel"
          autoComplete="tel"
          value={mobile}
          placeholder="07700 900123"
          onChange={(event) => setMobile(event.target.value)}
        />
      </label>
      {mobile.trim() === "" && (
        <p className="field-errors">
          Without a mobile you won't get texts, including the ones about emergencies.
        </p>
      )}
      <label className="stacked">
        Email, for the full details and transcript
        <input
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      {problems.length > 0 && (
        <ul className="field-errors">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      {error && <ErrorNote error={error} />}
      <div className="save-bar">
        <button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && <span className="muted">Saved. The next message goes to these.</span>}
      </div>
    </form>
  );
}

/** The export needs the login token, so it's fetched first and then handed to the browser to save. */
function DataDownload({ tenantId }: { tenantId: string }) {
  const { fetchBlob } = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const file = await fetchBlob(`/tenants/${tenantId}/export`);
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = `answermate-export-${ukDate(new Date())}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(asError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>Your data</h2>
      <p>
        Download everything AnswerMate holds about this business, as one file: its details, the
        assistant's settings, every call with its transcript, and the messages sent about them.
      </p>
      <button type="button" className="secondary" disabled={busy} onClick={() => void download()}>
        {busy ? "Preparing…" : "Download my data"}
      </button>
      {error && <ErrorNote error={error} />}
    </section>
  );
}

const CONFIRM_WORD = "CANCEL";

function Cancel({ tenant, onCancelled }: { tenant: TenantView; onCancelled: () => void }) {
  const { api } = useApi();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  if (tenant.status === "cancelling" || tenant.status === "cancelled") {
    return (
      <section className="card">
        <h2>Cancelled</h2>
        <p>
          AnswerMate has been cancelled for this business. Callers to its number hear that the
          service has ended. Remember to remove the call divert from your own phone.
        </p>
      </section>
    );
  }
  if (tenant.status !== "live" && tenant.status !== "paused") return null;

  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      await api<CancellationView>(`/tenants/${tenant.id}/cancel`, { method: "POST", body: {} });
      onCancelled();
    } catch (caught) {
      setError(asError(caught));
      setBusy(false);
    }
  };

  return (
    <section className="card danger-zone">
      <h2>Cancel AnswerMate</h2>
      <p>
        From the moment you cancel, callers to your AnswerMate number hear that the service has
        ended, and the assistant stops taking messages. Remember to remove the call divert from your
        own phone. To switch off for a while instead, use the switch on the Calls tab.
      </p>
      <label className="stacked">
        Type {CONFIRM_WORD} to confirm
        <input value={typed} onChange={(event) => setTyped(event.target.value)} />
      </label>
      <button
        type="button"
        className="danger"
        disabled={busy || typed.trim().toUpperCase() !== CONFIRM_WORD}
        onClick={() => void cancel()}
      >
        {busy ? "Cancelling…" : "Cancel AnswerMate"}
      </button>
      {error && <ErrorNote error={error} />}
    </section>
  );
}
