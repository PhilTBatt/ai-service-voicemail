// The business's account: its number, where messages go, a download of everything we hold,
// and leaving.
import {
  CSV_EXPORTS,
  CSV_EXPORT_LABELS,
  PILOT,
  notificationSettingsSchema,
  type BillingView,
  type CancellationView,
  type UndoCancellationView,
  type DirectDebitStartView,
  type DocumentsView,
  type MeView,
  type NotificationSettings,
  type SuspensionView,
  type TenantView,
} from "@callmate/shared";
import { useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { ApiError, asError, useApi, useLoad } from "../api.ts";
import {
  CHARGE_STATUS_LABELS,
  formatPence,
  formatPhone,
  humanise,
  toUkMobileE164,
} from "../format.ts";
import { NumberSection } from "../number-section.tsx";
import { TenantHeader } from "../tenant-header.tsx";
import { addDays, formatDate, formatUkDateTime, ukDate } from "../time.ts";
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
      <Billing key={`b-${tenant.data.id}`} tenant={tenant.data} />
      {me.role === "admin" && (
        <Suspension key={`s-${tenant.data.id}`} tenant={tenant.data} onChanged={tenant.reload} />
      )}
      <Documents
        key={`d-${tenant.data.id}`}
        tenant={tenant.data}
        canAccept={me.role === "owner"}
        onAccepted={tenant.reload}
      />
      <DataDownload tenantId={tenant.data.id} />
      <Cancel tenant={tenant.data} isAdmin={me.role === "admin"} onChanged={tenant.reload} />
    </>
  );
}

/**
 * The legal documents (BUILD_PLAN Step 11), and accepting any whose current version the
 * business hasn't: new, or changed since. Only the owner can accept, for their business.
 */
function Documents({
  tenant,
  canAccept,
  onAccepted,
}: {
  tenant: TenantView;
  canAccept: boolean;
  onAccepted: () => void;
}) {
  const { api } = useApi();
  const documents = useLoad(
    () => api<DocumentsView>(`/tenants/${tenant.id}/documents`),
    `documents-${tenant.id}`,
  );
  const [ticked, setTicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  if (documents.status === "loading") return <p className="muted">Loading documents…</p>;
  if (documents.status === "error") {
    return <ErrorNote error={documents.error} retry={documents.reload} />;
  }
  const outstanding = documents.data.documents.filter((document) => document.needsAccepting);

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      // The versions shown here: the API refuses any that changed since this page loaded.
      await api<DocumentsView>(`/tenants/${tenant.id}/documents/accept`, {
        method: "POST",
        body: { versions: Object.fromEntries(outstanding.map((d) => [d.type, d.version])) },
      });
      setTicked(false);
      documents.reload();
      onAccepted();
    } catch (caught) {
      setError(asError(caught));
      // A newer version arrived: show it, so what's ticked next is what's on screen.
      if (caught instanceof ApiError && caught.status === 409) documents.reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" id="documents">
      <h2>Documents</h2>
      <ul className="list">
        {documents.data.documents.map((document) => (
          <li key={document.type}>
            <p>
              <strong>{document.title}</strong>{" "}
              <span className="muted">version {document.version}</span>
            </p>
            <p>{document.summary}</p>
            {document.url && (
              <p>
                <a href={document.url} target="_blank" rel="noreferrer">
                  Read the {document.title}
                </a>
              </p>
            )}
            <p className={document.needsAccepting ? "" : "muted"}>
              {document.needsAccepting
                ? document.acceptedAt
                  ? `An earlier version was accepted on ${formatUkDateTime(document.acceptedAt)}: this one needs accepting.`
                  : "Not accepted yet."
                : `Accepted on ${formatUkDateTime(document.acceptedAt!)}.`}
            </p>
          </li>
        ))}
      </ul>
      {outstanding.length > 0 && canAccept && (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={ticked}
              onChange={(event) => setTicked(event.target.checked)}
            />{" "}
            I've read {outstanding.length === 1 ? "this document" : "these documents"} and accept{" "}
            {outstanding.length === 1 ? "it" : "them"} for {tenant.businessName}.
          </label>
          <button type="button" disabled={!ticked || busy} onClick={() => void accept()}>
            {busy ? "Saving…" : "Accept"}
          </button>
        </>
      )}
      {outstanding.length > 0 && !canAccept && (
        <p className="muted">Only the business's owner can accept these.</p>
      )}
      {error && <ErrorNote error={error} />}
    </section>
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

/**
 * The plan, this billing month so far, and Direct Debit (BUILD_PLAN Step 12). Setting one up
 * sends the person to the payments provider's own page for their bank details; it sends them
 * back here with ?directDebit=done, and this asks the server whether it's finished.
 */
function Billing({ tenant }: { tenant: TenantView }) {
  const { api } = useApi();
  const [searchParams, setSearchParams] = useSearchParams();
  const billing = useLoad(
    () => api<BillingView>(`/tenants/${tenant.id}/billing`),
    `billing-${tenant.id}`,
  );
  const [checked, setChecked] = useState<BillingView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const returned = searchParams.get("directDebit") === "done";
  const checking = useRef(false);

  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      setChecked(
        await api<BillingView>(`/tenants/${tenant.id}/billing/direct-debit/check`, {
          method: "POST",
          body: {},
        }),
      );
    } catch (caught) {
      setError(asError(caught));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!returned || checking.current) return;
    checking.current = true;
    void api<BillingView>(`/tenants/${tenant.id}/billing/direct-debit/check`, {
      method: "POST",
      body: {},
    })
      .then(setChecked, (caught: unknown) => setError(asError(caught)))
      .finally(() => setSearchParams({}, { replace: true }));
  }, [returned, api, tenant.id, setSearchParams]);

  if (billing.status === "loading") return <p className="muted">Loading billing…</p>;
  if (billing.status === "error") return <ErrorNote error={billing.error} retry={billing.reload} />;
  const view = checked ?? billing.data;
  const { plan, period, directDebit } = view;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const { authorisationUrl } = await api<DirectDebitStartView>(
        `/tenants/${tenant.id}/billing/direct-debit`,
        { method: "POST", body: {} },
      );
      window.location.assign(authorisationUrl);
    } catch (caught) {
      setError(asError(caught));
      setBusy(false);
    }
  };

  const minutesUsed = period ? Math.ceil(period.billableSeconds / 60) : 0;
  const leaving = tenant.status === "cancelling" || tenant.status === "cancelled";

  return (
    <section className="card" id="billing">
      <h2>Plan and payment</h2>
      <p>
        <strong>{plan.name}</strong>: {formatPence(plan.monthlyPence)} a month, with{" "}
        {plan.includedMinutes} minutes of calls included, then {plan.overagePencePerMinute}p a
        minute. Prices are before VAT.
      </p>
      {view.isPilot && (
        <p className="muted">
          This business is on the pilot: the first month's fee is waived, then it's{" "}
          {formatPence(PILOT.reducedMonthlyPence)} a month for {PILOT.reducedMonths} months, then
          the plan's price.
        </p>
      )}
      {period ? (
        <p>
          This billing month ({formatDate(period.start)} to {formatDate(addDays(period.end, -1))},
          month {period.month}): {minutesUsed} of {plan.includedMinutes} minutes used so far. This
          month's fee is {formatPence(period.feePence)}, charged by Direct Debit after the month
          ends.
        </p>
      ) : view.leftOn ? (
        <p className="muted">
          This business left AnswerMate on {formatDate(view.leftOn)}. The month it left in is
          charged as usual; nothing after that.
        </p>
      ) : (
        <p className="muted">
          Nothing is charged until AnswerMate is answering this business's calls.
        </p>
      )}
      <h3>Direct Debit</h3>
      {directDebit.status === "active" && (
        <p>
          Set up
          {directDebit.since ? ` on ${formatUkDateTime(directDebit.since)}` : ""}. Each month's
          charge is collected from it automatically.
        </p>
      )}
      {directDebit.status === "pending" && (
        <>
          <p>
            Started but not finished. If you've just given your bank details, it can take a moment
            to show here.
          </p>
          {view.available && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void check()}
            >
              Check again
            </button>
          )}
        </>
      )}
      {directDebit.status === "ended" && (
        <p className="field-errors">
          The Direct Debit ended
          {directDebit.since ? ` on ${formatUkDateTime(directDebit.since)}` : ""}
          {directDebit.endReason ? ` (${humanise(directDebit.endReason)})` : ""}, so nothing can be
          collected.{" "}
          {leaving
            ? "If anything below is still owed, we'll be in touch about it."
            : "Please set it up again."}
        </p>
      )}
      {directDebit.status === "none" && !view.isPilot && (
        <p>Not set up yet. It's needed before AnswerMate can start answering calls.</p>
      )}
      {directDebit.status !== "active" && !leaving && (
        <>
          {view.available ? (
            <button type="button" disabled={busy} onClick={() => void start()}>
              {busy ? "One moment…" : "Set up Direct Debit"}
            </button>
          ) : (
            <p className="muted">Direct Debit isn't available yet.</p>
          )}
          <p className="muted">
            You'll give your bank details on GoCardless's secure page, then come back here. You can
            cancel a Direct Debit at your bank at any time.
          </p>
        </>
      )}
      {error && <ErrorNote error={error} />}
      {view.charges.length > 0 && (
        <>
          <h3>Past months</h3>
          <ul className="list">
            {view.charges.map((charge) => (
              <li key={charge.periodStart}>
                <p>
                  <strong>
                    {formatDate(charge.periodStart)} to {formatDate(addDays(charge.periodEnd, -1))}
                  </strong>
                  : {formatPence(charge.totalPence)}
                  {charge.vatPence > 0
                    ? ` (including ${formatPence(charge.vatPence)} VAT)`
                    : ""}, {CHARGE_STATUS_LABELS[charge.status] ?? charge.status}
                  {charge.chargeDate ? `, collected from ${formatDate(charge.chargeDate)}` : ""}
                </p>
                <p className="muted">
                  {charge.lines
                    .map((line) => `${line.description}: ${formatPence(line.pence)}`)
                    .join(" · ")}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * Suspending a business (admin only; Step 12: never automatic, say for not paying). Its callers
 * get the fallback voicemail until it's resumed. The business's own on/off switch and texts
 * can't undo it.
 */
function Suspension({ tenant, onChanged }: { tenant: TenantView; onChanged: () => void }) {
  const { api } = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const suspended = tenant.status === "suspended";
  if (!suspended && tenant.status !== "live" && tenant.status !== "paused") return null;

  const act = async () => {
    const question = suspended
      ? `Resume ${tenant.businessName}? Its calls go back to the assistant.`
      : `Suspend ${tenant.businessName}? Every caller gets the voicemail until you resume it. The business isn't told by us.`;
    if (!window.confirm(question)) return;
    setBusy(true);
    setError(null);
    try {
      await api<SuspensionView>(`/admin/tenants/${tenant.id}/${suspended ? "resume" : "suspend"}`, {
        method: "POST",
        body: suspended ? {} : { confirm: true },
      });
      onChanged();
    } catch (caught) {
      setError(asError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`card ${suspended ? "error" : ""}`}>
      <h2>Suspension</h2>
      <p>
        {suspended
          ? "This business is suspended: callers get the voicemail, and its own switch can't turn the assistant back on."
          : "Suspending stops the assistant answering for this business until you resume it. Nothing does this automatically, missed payments included."}
      </p>
      <button
        type="button"
        className={suspended ? "" : "danger"}
        disabled={busy}
        onClick={() => void act()}
      >
        {busy ? "One moment…" : suspended ? "Resume" : "Suspend"}
      </button>
      {error && <ErrorNote error={error} />}
    </section>
  );
}

/** The export needs the login token, so it's fetched first and then handed to the browser to save. */
function DataDownload({ tenantId }: { tenantId: string }) {
  const { fetchBlob } = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const download = async (path: string, name: string, extension: string) => {
    setBusy(true);
    setError(null);
    try {
      const file = await fetchBlob(`/tenants/${tenantId}/${path}`);
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = `answermate-${name}-${ukDate(new Date())}.${extension}`;
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
      <button
        type="button"
        className="secondary"
        disabled={busy}
        onClick={() => void download("export", "export", "json")}
      >
        {busy ? "Preparing…" : "Download my data"}
      </button>
      <p className="muted">Or one table at a time, for a spreadsheet (times are UK time):</p>
      <div className="actions">
        {CSV_EXPORTS.map((table) => (
          <button
            key={table}
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void download(`export.csv?table=${table}`, table, "csv")}
          >
            {CSV_EXPORT_LABELS[table]} (CSV)
          </button>
        ))}
      </div>
      {error && <ErrorNote error={error} />}
    </section>
  );
}

const CONFIRM_WORD = "CANCEL";

/** The statuses a business can leave from (the API's CANCELLABLE says the same). */
const CANCELLABLE = ["live", "paused", "suspended", "onboarding"];

function Cancel({
  tenant,
  isAdmin,
  onChanged,
}: {
  tenant: TenantView;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const { api } = useApi();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // The admin can take a cancellation back while the number is still the business's.
  const undo = async () => {
    if (!window.confirm("Undo the cancellation? The business goes back to how it was before.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api<UndoCancellationView>(`/admin/tenants/${tenant.id}/undo-cancellation`, {
        method: "POST",
        body: { confirm: true },
      });
      onChanged();
    } catch (caught) {
      setError(asError(caught));
      setBusy(false);
    }
  };

  if (tenant.status === "cancelling" || tenant.status === "cancelled") {
    return (
      <section className="card">
        <h2>Cancelled</h2>
        {tenant.status === "cancelling" && tenant.releaseDueAt ? (
          <p>
            AnswerMate has been cancelled for this business
            {tenant.cancellationRequestedAt
              ? ` (on ${formatUkDateTime(tenant.cancellationRequestedAt)})`
              : ""}
            . Callers to its number hear that the service has ended until{" "}
            {formatUkDateTime(tenant.releaseDueAt)}, then the number is released.
          </p>
        ) : (
          <p>AnswerMate has been cancelled for this business, and its number released.</p>
        )}
        <p>
          We've texted and emailed how to turn off your diverts and get your voicemail back. The
          codes are on the Phone setup tab too.
        </p>
        {isAdmin && tenant.status === "cancelling" && (
          <>
            <button type="button" disabled={busy} onClick={() => void undo()}>
              Undo cancellation
            </button>
            {error && <ErrorNote error={error} />}
          </>
        )}
      </section>
    );
  }
  if (!CANCELLABLE.includes(tenant.status)) return null;

  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      await api<CancellationView>(`/tenants/${tenant.id}/cancel`, {
        method: "POST",
        body: { confirm: true },
      });
      onChanged();
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
        ended, and the assistant stops taking messages. We'll text and email you how to turn off
        your diverts and get your voicemail back. To switch off for a while instead, use the switch
        on the Calls tab.
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
