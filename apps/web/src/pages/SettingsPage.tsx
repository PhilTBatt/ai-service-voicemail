// The business's account: its number, where messages go, the plan and Direct Debit, the
// documents, a download of everything we hold, and leaving.
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
  type NotificationSettings,
  type SuspensionView,
  type TenantView,
} from "@callmate/shared";
import { useEffect, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router";
import { ApiError, asError, useApi, useLoad } from "../api.ts";
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  DescriptionList,
  ErrorNote,
  Loading,
  Meter,
  SectionHeader,
  TextField,
} from "../design/components.tsx";
import { useConfirm, useConfirmTyped } from "../design/dialog.tsx";
import {
  Ban,
  Check,
  CreditCard,
  Download,
  ExternalLink,
  FileText,
  Mail,
  Power,
  RotateCcw,
  TriangleAlert,
  Undo2,
} from "../design/icons.ts";
import { useToast } from "../design/toast.tsx";
import {
  CHARGE_STATUS_LABELS,
  chargeTone,
  formatPence,
  formatPhone,
  humanise,
  toUkMobileE164,
} from "../format.ts";
import { NumberSection } from "../number-section.tsx";
import { useTenant } from "../tenant-layout.tsx";
import { addDays, formatDate, formatUkDateTime, ukDate } from "../time.ts";

export function SettingsPage() {
  const { me, tenant, reload } = useTenant();
  return (
    <div className="stack stack-lg">
      <SectionHeader title="Account" />
      <NumberSection tenant={tenant} isAdmin={me.role === "admin"} onBought={reload} />
      <Notifications key={`n-${tenant.id}`} tenant={tenant} />
      <Billing key={`b-${tenant.id}`} tenant={tenant} />
      {me.role === "admin" && (
        <Suspension key={`s-${tenant.id}`} tenant={tenant} onChanged={reload} />
      )}
      <Documents
        key={`d-${tenant.id}`}
        tenant={tenant}
        canAccept={me.role === "owner"}
        onAccepted={reload}
      />
      <DataDownload tenantId={tenant.id} />
      {/* Keyed by status: once a cancel or an undo shows, the card starts afresh (its button
          stays busy until then, as the page reloads the business in place). */}
      <Cancel
        key={`c-${tenant.status}`}
        tenant={tenant}
        isAdmin={me.role === "admin"}
        onChanged={reload}
      />
    </div>
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
  const toast = useToast();
  const { hash } = useLocation();
  const documents = useLoad(
    () => api<DocumentsView>(`/tenants/${tenant.id}/documents`),
    `documents-${tenant.id}`,
  );
  const [ticked, setTicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const ready = documents.status === "ready";

  // The reminder links to #documents: once they're on screen, go to them.
  useEffect(() => {
    if (ready && hash === "#documents") {
      document.getElementById("documents")?.scrollIntoView({ behavior: "smooth" });
    }
  }, [ready, hash]);

  if (documents.status === "loading") return <Loading label="Loading documents…" />;
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
      toast({ title: "Accepted. Thank you." });
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
    <Card
      id="documents"
      icon={FileText}
      title="Documents"
      flush
      footer={
        outstanding.length > 0 &&
        (canAccept ? (
          <div className="stack">
            <Checkbox
              label={`I've read ${outstanding.length === 1 ? "this document" : "these documents"} and accept ${outstanding.length === 1 ? "it" : "them"} for ${tenant.businessName}.`}
              checked={ticked}
              onChange={(event) => setTicked(event.target.checked)}
            />
            <div>
              <Button disabled={!ticked} loading={busy} onClick={() => void accept()}>
                Accept
              </Button>
            </div>
            {error && <ErrorNote error={error} />}
          </div>
        ) : (
          <p className="muted text-sm">Only the business's owner can accept these.</p>
        ))
      }
    >
      <ul className="list list-divided">
        {documents.data.documents.map((document) => (
          <li key={document.type} className="list-item">
            <div className="stack stack-sm">
              <div className="cluster">
                <h3 className="row-title">{document.title}</h3>
                <Badge>version {document.version}</Badge>
                {document.needsAccepting ? (
                  <Badge tone="warning">Needs accepting</Badge>
                ) : (
                  <Badge tone="success" icon={Check}>
                    Accepted
                  </Badge>
                )}
              </div>
              <p className="text-sm">{document.summary}</p>
              <p className="muted text-sm">
                {document.needsAccepting
                  ? document.acceptedAt
                    ? `An earlier version was accepted on ${formatUkDateTime(document.acceptedAt)}: this one needs accepting.`
                    : "Not accepted yet."
                  : `Accepted on ${formatUkDateTime(document.acceptedAt!)}.`}
              </p>
            </div>
            {document.url && (
              <a
                className="btn btn-secondary btn-sm"
                href={document.url}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink size={16} />
                Read the {document.title}
              </a>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Notifications({ tenant }: { tenant: TenantView }) {
  const { api } = useApi();
  const toast = useToast();
  const [mobile, setMobile] = useState(
    tenant.notificationMobile ? formatPhone(tenant.notificationMobile) : "",
  );
  const [email, setEmail] = useState(tenant.notificationEmail ?? "");
  const [problems, setProblems] = useState<{ mobile?: string[]; email?: string[] }>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const save = async () => {
    const candidate = {
      notificationMobile: mobile.trim() === "" ? null : toUkMobileE164(mobile),
      notificationEmail: email.trim() === "" ? null : email.trim(),
    };
    const checked = notificationSettingsSchema.safeParse(candidate);
    if (!checked.success) {
      const issues = checked.error.issues;
      const about = (field: string) =>
        issues.filter((issue) => issue.path[0] === field).map((issue) => issue.message);
      setProblems({ mobile: about("notificationMobile"), email: about("notificationEmail") });
      return;
    }
    setProblems({});
    setSaving(true);
    setError(null);
    try {
      await api<NotificationSettings>(`/tenants/${tenant.id}/notifications`, {
        method: "PUT",
        body: checked.data,
      });
      toast({ title: "Saved", body: "The next message goes to these." });
    } catch (caught) {
      setError(asError(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      // The schema checks it, and says what's wrong by each field. Without this, the browser's
      // own email check stopped the form first: its own bubble, in its own words, and nothing
      // said about the mobile until the email was put right.
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Card
        icon={Mail}
        title="Where your messages go"
        description="A text about each call as it ends, and an email with the full details."
        footer={
          <Button type="submit" loading={saving}>
            Save
          </Button>
        }
      >
        <TextField
          label="Mobile, for texts about each call"
          type="tel"
          autoComplete="tel"
          value={mobile}
          placeholder="07700 900123"
          error={problems.mobile}
          onChange={(event) => setMobile(event.target.value)}
        />
        {mobile.trim() === "" && (
          <Alert tone="warning">
            <p>Without a mobile you won't get texts, including the ones about emergencies.</p>
          </Alert>
        )}
        <TextField
          label="Email, for the full details and transcript"
          type="email"
          autoComplete="email"
          value={email}
          error={problems.email}
          onChange={(event) => setEmail(event.target.value)}
        />
        {error && <ErrorNote error={error} />}
      </Card>
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

  if (billing.status === "loading") return <Loading label="Loading billing…" />;
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
  const directDebitBadge = {
    active: (
      <Badge tone="success" icon={Check}>
        Set up
      </Badge>
    ),
    pending: <Badge tone="info">Started, not finished</Badge>,
    ended: <Badge tone="danger">Ended</Badge>,
    none: <Badge tone={view.isPilot ? "neutral" : "warning"}>Not set up</Badge>,
  }[directDebit.status];

  return (
    <Card
      id="billing"
      icon={CreditCard}
      title="Plan and payment"
      description="Prices are before VAT."
    >
      <div className="stack stack-sm">
        <p>
          <strong>{plan.name}</strong>: {formatPence(plan.monthlyPence)} a month, with{" "}
          {plan.includedMinutes} minutes of calls included, then {plan.overagePencePerMinute}p a
          minute.
        </p>
        {view.isPilot && (
          <p className="muted text-sm">
            This business is on the pilot: the first month's fee is waived, then it's{" "}
            {formatPence(PILOT.reducedMonthlyPence)} a month for {PILOT.reducedMonths} months, then
            the plan's price.
          </p>
        )}
      </div>

      {period ? (
        <div className="stack stack-sm">
          <div className="cluster cluster-between">
            <span className="text-sm">
              <strong>This month</strong>{" "}
              <span className="muted">
                {formatDate(period.start)} to {formatDate(addDays(period.end, -1))} (month{" "}
                {period.month})
              </span>
            </span>
            <span className="text-sm num">
              {minutesUsed} of {plan.includedMinutes} minutes
            </span>
          </div>
          <Meter value={minutesUsed} max={plan.includedMinutes} label="Minutes used this month" />
          <p className="muted text-sm">
            This month's fee is {formatPence(period.feePence)}, charged by Direct Debit after the
            month ends.
          </p>
        </div>
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

      <hr />
      <div className="stack stack-sm">
        <div className="cluster">
          <h3>Direct Debit</h3>
          {directDebitBadge}
        </div>
        {directDebit.status === "active" && (
          <p className="text-sm">
            Set up{directDebit.since ? ` on ${formatUkDateTime(directDebit.since)}` : ""}. Each
            month's charge is collected from it automatically.
          </p>
        )}
        {directDebit.status === "pending" && (
          <p className="text-sm">
            If you've just given your bank details, it can take a moment to show here.
          </p>
        )}
        {directDebit.status === "ended" && (
          <Alert tone="danger">
            <p>
              The Direct Debit ended
              {directDebit.since ? ` on ${formatUkDateTime(directDebit.since)}` : ""}
              {directDebit.endReason ? ` (${humanise(directDebit.endReason)})` : ""}, so nothing can
              be collected.{" "}
              {leaving
                ? "If anything below is still owed, we'll be in touch about it."
                : "Please set it up again."}
            </p>
          </Alert>
        )}
        {directDebit.status === "none" && !view.isPilot && (
          <p className="text-sm">It's needed before AnswerMate can start answering calls.</p>
        )}
        {directDebit.status !== "active" && !leaving && (
          <>
            {view.available ? (
              <div className="cluster">
                <Button loading={busy} onClick={() => void start()}>
                  Set up Direct Debit
                </Button>
                {directDebit.status === "pending" && (
                  <Button
                    variant="secondary"
                    icon={RotateCcw}
                    disabled={busy}
                    onClick={() => void check()}
                  >
                    Check again
                  </Button>
                )}
              </div>
            ) : (
              <p className="muted text-sm">Direct Debit isn't available yet.</p>
            )}
            <p className="muted text-sm">
              You'll give your bank details on GoCardless's secure page, then come back here. You
              can cancel a Direct Debit at your bank at any time.
            </p>
          </>
        )}
        {error && <ErrorNote error={error} />}
      </div>

      {view.charges.length > 0 && (
        <>
          <hr />
          <h3>Past months</h3>
          <div className="table-wrap">
            <table className="table table-stack">
              <thead>
                <tr>
                  <th>Month</th>
                  <th className="num">Total</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {view.charges.map((charge) => (
                  <tr key={charge.periodStart}>
                    <td data-label="Month">
                      <div className="stack stack-xs">
                        <strong>
                          {formatDate(charge.periodStart)} to{" "}
                          {formatDate(addDays(charge.periodEnd, -1))}
                        </strong>
                        <span className="muted text-xs">
                          {charge.lines
                            .map((line) => `${line.description}: ${formatPence(line.pence)}`)
                            .join(" · ")}
                        </span>
                      </div>
                    </td>
                    <td data-label="Total" className="num">
                      {formatPence(charge.totalPence)}
                      {charge.vatPence > 0 && (
                        <span className="muted text-xs">
                          {" "}
                          incl. {formatPence(charge.vatPence)} VAT
                        </span>
                      )}
                    </td>
                    <td data-label="Status">
                      <div className="stack stack-xs">
                        <span>
                          <Badge tone={chargeTone(charge.status)}>
                            {CHARGE_STATUS_LABELS[charge.status] ?? charge.status}
                          </Badge>
                        </span>
                        {charge.chargeDate && (
                          <span className="muted text-xs">
                            Collected from {formatDate(charge.chargeDate)}
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}

/**
 * Suspending a business (admin only; Step 12: never automatic, say for not paying). Its callers
 * get the fallback voicemail until it's resumed. The business's own on/off switch and texts
 * can't undo it. A month it spends suspended from start to end isn't charged (decision 019).
 */
function Suspension({ tenant, onChanged }: { tenant: TenantView; onChanged: () => void }) {
  const { api } = useApi();
  const confirm = useConfirm();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const suspended = tenant.status === "suspended";
  if (!suspended && tenant.status !== "live" && tenant.status !== "paused") return null;

  const act = async () => {
    const yes = await confirm(
      suspended
        ? {
            title: `Resume ${tenant.businessName}?`,
            body: "Its calls go back to the assistant straight away, and billing picks up again.",
            confirmLabel: "Resume",
          }
        : {
            title: `Suspend ${tenant.businessName}?`,
            body: (
              <>
                <p>
                  Every caller gets the voicemail until you resume it. The business isn't told by
                  us.
                </p>
                <p>
                  Any month it spends suspended from start to end isn't charged; the month it's
                  suspended in still is.
                </p>
              </>
            ),
            confirmLabel: "Suspend",
            tone: "danger",
          },
    );
    if (!yes) return;
    setBusy(true);
    setError(null);
    try {
      await api<SuspensionView>(`/admin/tenants/${tenant.id}/${suspended ? "resume" : "suspend"}`, {
        method: "POST",
        body: suspended ? {} : { confirm: true },
      });
      toast({ title: suspended ? "Resumed" : "Suspended" });
      onChanged();
    } catch (caught) {
      setError(asError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      icon={suspended ? Ban : Power}
      tone={suspended ? "danger" : undefined}
      title="Suspension"
      description="Admin only."
      footer={
        <Button
          variant={suspended ? "primary" : "danger"}
          loading={busy}
          onClick={() => void act()}
        >
          {suspended ? "Resume" : "Suspend"}
        </Button>
      }
    >
      <p>
        {suspended
          ? "This business is suspended: callers get the voicemail, its own switch can't turn the assistant back on, and a month spent suspended from start to end isn't charged."
          : "Suspending stops the assistant answering for this business until you resume it. Nothing does this automatically, missed payments included."}
      </p>
      {error && <ErrorNote error={error} />}
    </Card>
  );
}

/** The export needs the login token, so it's fetched first and then handed to the browser to save. */
function DataDownload({ tenantId }: { tenantId: string }) {
  const { fetchBlob } = useApi();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const download = async (path: string, name: string, extension: string) => {
    setBusy(name);
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
      setBusy(null);
    }
  };

  return (
    <Card
      icon={Download}
      title="Your data"
      description="Everything AnswerMate holds about this business, yours to keep."
    >
      <div className="stack stack-sm">
        <p className="text-sm">
          As one file: its details, the assistant's settings, every call with its transcript, and
          the messages sent about them.
        </p>
        <div>
          <Button
            variant="secondary"
            icon={Download}
            loading={busy === "export"}
            disabled={busy !== null}
            onClick={() => void download("export", "export", "json")}
          >
            Download my data
          </Button>
        </div>
      </div>
      <div className="stack stack-sm">
        <p className="muted text-sm">
          Or one table at a time, for a spreadsheet (times are UK time):
        </p>
        <div className="cluster">
          {CSV_EXPORTS.map((table) => (
            <Button
              key={table}
              variant="secondary"
              size="sm"
              loading={busy === table}
              disabled={busy !== null}
              onClick={() => void download(`export.csv?table=${table}`, table, "csv")}
            >
              {CSV_EXPORT_LABELS[table]} (CSV)
            </Button>
          ))}
        </div>
      </div>
      {error && <ErrorNote error={error} />}
    </Card>
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
  const confirm = useConfirm();
  const confirmTyped = useConfirmTyped();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // The admin can take a cancellation back while the number is still the business's.
  const undo = async () => {
    const yes = await confirm({
      title: "Undo the cancellation?",
      body: "The business goes back to how it was before it cancelled.",
      confirmLabel: "Undo cancellation",
    });
    if (!yes) return;
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
      <Card
        icon={Ban}
        title="Cancelled"
        footer={
          isAdmin &&
          tenant.status === "cancelling" && (
            <Button variant="secondary" icon={Undo2} loading={busy} onClick={() => void undo()}>
              Undo cancellation
            </Button>
          )
        }
      >
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
        <p className="muted text-sm">
          We've texted and emailed how to turn off your diverts and get your voicemail back. The
          codes are on the Phone setup page too.
        </p>
        {error && <ErrorNote error={error} />}
      </Card>
    );
  }
  if (!CANCELLABLE.includes(tenant.status)) return null;

  const cancel = async () => {
    const typed = await confirmTyped({
      title: "Cancel AnswerMate?",
      body: (
        <>
          <p>
            From the moment you cancel, callers to your AnswerMate number hear that the service has
            ended, and the assistant stops taking messages.
          </p>
          <p>We'll text and email you how to turn off your diverts and get your voicemail back.</p>
        </>
      ),
      requireText: CONFIRM_WORD,
      confirmLabel: "Cancel AnswerMate",
      cancelLabel: "Keep AnswerMate",
      tone: "danger",
    });
    if (typed === null) return;
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
    <Card
      icon={TriangleAlert}
      tone="danger"
      className="danger-zone"
      title="Cancel AnswerMate"
      footer={
        <Button variant="danger" loading={busy} onClick={() => void cancel()}>
          Cancel AnswerMate
        </Button>
      }
    >
      <DescriptionList
        items={[
          {
            term: "Callers",
            detail: "Hear that the service has ended, from the moment you cancel.",
          },
          { term: "Your number", detail: "Is kept for 30 days, then released." },
          {
            term: "Billing",
            detail: "Nothing is charged for any month after the one you leave in.",
          },
        ]}
      />
      <p className="muted text-sm">
        To switch off for a while instead, use the switch on the Calls page.
      </p>
      {error && <ErrorNote error={error} />}
    </Card>
  );
}
