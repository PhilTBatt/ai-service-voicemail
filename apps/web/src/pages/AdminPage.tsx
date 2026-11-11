// Phil's view of the whole service: is it healthy, which calls need a look, how much each
// business is using, and what that costs us. The API answers these only for the admin role; this page is just a view.
import type {
  AdminBillingView,
  CallReviewedView,
  CancellationsView,
  CostRowView,
  CostsView,
  DataDeletionView,
  HealthView,
  KillSwitchView,
  ReleasedNumberView,
  ReviewQueueView,
  UsageView,
} from "@callmate/shared";
import { useState } from "react";
import { Link } from "react-router";
import { asError, useApi, useLoad } from "../api.ts";
import {
  CHARGE_STATUS_LABELS,
  formatDuration,
  formatPence,
  formatPhone,
  humanise,
} from "../format.ts";
import { addDays, formatDate, formatUkDateTime } from "../time.ts";
import { ErrorNote, StatusBadge, UrgencyBadge } from "../ui.tsx";

export function AdminPage() {
  return (
    <>
      <h1>Admin</h1>
      <Health />
      <Billing />
      <Leaving />
      <ReviewQueue />
      <Usage />
      <Costs />
    </>
  );
}

/**
 * Billing at a glance (Step 12): this month's money, and the charges that need a person.
 * A failed payment can be collected again here, as GoCardless's own retry of it.
 */
function Billing() {
  const { api } = useApi();
  const billing = useLoad(() => api<AdminBillingView>("/admin/billing"), "admin-billing");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);

  if (billing.status === "loading") return <p className="muted">Loading billing…</p>;
  if (billing.status === "error") return <ErrorNote error={billing.error} retry={billing.reload} />;
  const { thisMonth, attention, available, environment } = billing.data;

  const collectAgain = async (chargeId: string, businessName: string) => {
    if (!window.confirm(`Ask GoCardless to collect ${businessName}'s payment again?`)) return;
    setBusy(chargeId);
    setError(null);
    try {
      await api(`/admin/charges/${chargeId}/collect-again`, { method: "POST", body: {} });
      billing.reload();
    } catch (caught) {
      setError(asError(caught));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section>
      <h2>Billing</h2>
      {environment === "sandbox" && (
        <div className="card error">
          <p>
            <strong>Payments are on GoCardless's sandbox: no real money moves.</strong> Before the
            first paying customer, switch to the live account (RUNBOOK section 17).
          </p>
        </div>
      )}
      <div className="stats">
        <Money label="Collected this month" pence={thisMonth.collectedPence} />
        <Money label="Being collected" pence={thisMonth.collectingPence} />
        <Money label="Not collected" pence={thisMonth.problemPence} />
      </div>
      <p className="muted">
        By the day each month was charged. Prices before VAT unless VAT is set up.
      </p>
      {attention.length === 0 ? (
        <p className="muted">No payments need you.</p>
      ) : (
        <div className="card error">
          <h3>Payments that need you</h3>
          <p className="muted">
            Nothing is switched off for not paying: suspending a business is on its Account tab.
            "Owed, no Direct Debit" is collected by itself once the business sets one up.
          </p>
          <ul className="list">
            {attention.map((charge) => (
              <li key={charge.chargeId}>
                <Link to={`/tenants/${charge.tenantId}/settings#billing`}>
                  {charge.businessName}
                </Link>
                , {formatDate(charge.periodStart)} to {formatDate(addDays(charge.periodEnd, -1))}:{" "}
                {formatPence(charge.totalPence)},{" "}
                {CHARGE_STATUS_LABELS[charge.status] ?? charge.status}
                {charge.failureReason ? ` (${humanise(charge.failureReason)})` : ""}
                {charge.canCollectAgain && available && (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy !== null}
                      onClick={() => void collectAgain(charge.chargeId, charge.businessName)}
                    >
                      {busy === charge.chargeId ? "Asking…" : "Collect again"}
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && <ErrorNote error={error} />}
    </section>
  );
}

function Money({ label, pence }: { label: string; pence: number }) {
  return (
    <div className="card stat">
      <strong>{formatPence(pence)}</strong>
      <span className="muted">{label}</span>
    </div>
  );
}

function Health() {
  const { api } = useApi();
  const health = useLoad(() => api<HealthView>("/admin/health"), "health");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  if (health.status === "loading") return <p className="muted">Loading health…</p>;
  if (health.status === "error") return <ErrorNote error={health.error} retry={health.reload} />;

  const data = health.data;
  const flip = async () => {
    const question = data.killSwitchOn
      ? "Turn the kill switch off? Calls go back to the assistant."
      : "Turn the kill switch ON? Every caller on every number goes straight to voicemail until you turn it off.";
    if (!window.confirm(question)) return;
    setBusy(true);
    setError(null);
    try {
      await api<KillSwitchView>("/admin/kill-switch", {
        method: "PUT",
        body: { on: !data.killSwitchOn },
      });
      health.reload();
    } catch (caught) {
      setError(asError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2>Health</h2>
      <div className={`card switch ${data.killSwitchOn ? "error" : ""}`}>
        <p>
          Kill switch is{" "}
          <strong>{data.killSwitchOn ? "ON: every call goes to voicemail" : "off"}</strong>
        </p>
        <button
          type="button"
          className={data.killSwitchOn ? "" : "danger"}
          disabled={busy}
          onClick={() => void flip()}
        >
          {data.killSwitchOn ? "Turn off" : "Turn on"}
        </button>
        {error && <ErrorNote error={error} />}
      </div>
      <Worker worker={data.worker} />
      <ScheduledJobs jobs={data.scheduledJobs} />
      <div className="stats">
        {/* Voicemails left, not plays: a caller who hangs up at the greeting isn't counted (the
          fallback-voicemail-spike alert counts every play). */}
        <Stat label="Voicemails left" value={data.fallbackCalls} />
        <Stat label="Texts and emails that failed" value={data.failedNotifications} />
        <Stat label="Jobs that failed every retry" value={data.deadLetteredJobs24h} />
      </div>
      <p className="muted">Counts cover the last 24 hours.</p>
      {data.failedNotificationsRecent.length > 0 && (
        <div className="card error">
          <h3>Texts and emails that couldn't be sent</h3>
          <p className="muted">
            Newest first. "Failed" is the provider refusing the send, with its reason; "undelivered"
            is the carrier's verdict afterwards, with its code.
          </p>
          <ul>
            {data.failedNotificationsRecent.map((failed) => (
              <li key={`${failed.callId}:${failed.channel}`}>
                {formatUkDateTime(failed.at)}:{" "}
                <Link to={`/tenants/${failed.tenantId}/calls/${failed.callId}`}>
                  {failed.businessName}
                </Link>
                , {failed.channel}, {failed.status} after {failed.attempts}{" "}
                {failed.attempts === 1 ? "attempt" : "attempts"}
                {failed.failureReason ? `: ${failed.failureReason}` : ""}
                {failed.failureCode ? ` (code ${failed.failureCode})` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.deadLetteredJobsRecent.length > 0 && (
        <div className="card error">
          <h3>Jobs that failed every retry</h3>
          <p className="muted">Newest first, with the error that ended the last attempt.</p>
          <ul>
            {data.deadLetteredJobsRecent.map((job, index) => (
              <li key={`${job.at}:${index}`}>
                {formatUkDateTime(job.at)}: {job.queue}
                {job.tenantId && job.callId ? (
                  <>
                    {" "}
                    for <Link to={`/tenants/${job.tenantId}/calls/${job.callId}`}>this call</Link>
                  </>
                ) : job.tenantId ? (
                  <>
                    {" "}
                    for <Link to={`/tenants/${job.tenantId}`}>this business</Link>
                  </>
                ) : null}
                {job.error ? `: ${job.error}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.waitingSyncs.length > 0 && (
        <div className="card error">
          <h3>Assistants waiting to be updated</h3>
          <p className="muted">
            Saved over five minutes ago, and nothing has synced them yet: is the worker running?
          </p>
          <ul>
            {data.waitingSyncs.map((sync) => (
              <li key={sync.tenantId}>
                <Link to={`/tenants/${sync.tenantId}/profile`}>{sync.businessName}</Link>, version{" "}
                {sync.version}, saved {formatUkDateTime(sync.savedAt)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.failedSyncs.length > 0 && (
        <div className="card error">
          <h3>Assistants that couldn't be updated</h3>
          <ul>
            {data.failedSyncs.map((sync) => (
              <li key={sync.tenantId}>
                <Link to={`/tenants/${sync.tenantId}/profile`}>{sync.businessName}</Link>, version{" "}
                {sync.version}: {sync.error}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Whether anything is running the jobs: syncs, summaries, texts and emails. */
function Worker({ worker }: { worker: HealthView["worker"] }) {
  if (worker.state === "running") {
    return (
      <p className="muted">
        The worker is running: it last checked in at {formatUkDateTime(worker.lastSeen!)}.
      </p>
    );
  }
  return (
    <div className="card error">
      <p>
        <strong>
          {worker.state === "never"
            ? "No worker has checked in yet."
            : `The worker hasn't checked in since ${formatUkDateTime(worker.lastSeen!)}.`}
        </strong>{" "}
        Until one runs, assistants aren't updated and no call summaries, texts or emails go out.
        Check the worker's logs (locally, start it with npm run worker).
      </p>
    </div>
  );
}

/**
 * The recurring jobs: when each last ran, and a red card if one has stopped. A failure shows
 * only when it's newer than the last success (an older one has been put right since).
 */
function ScheduledJobs({ jobs }: { jobs: HealthView["scheduledJobs"] }) {
  if (jobs.length === 0) {
    return <p className="muted">No scheduled job has run yet.</p>;
  }
  const overdue = jobs.some((job) => job.overdue);
  return (
    <div className={`card ${overdue ? "error" : ""}`}>
      <h3>Scheduled jobs</h3>
      <ul>
        {jobs.map((job) => (
          <li key={job.queue}>
            {job.overdue && <strong>Overdue: </strong>}
            {job.label}:{" "}
            {job.lastSucceededAt
              ? `last ran ${formatUkDateTime(job.lastSucceededAt)}`
              : "hasn't run yet"}
            {job.lastFailedAt && (!job.lastSucceededAt || job.lastFailedAt > job.lastSucceededAt)
              ? `; last failed ${formatUkDateTime(job.lastFailedAt)}`
              : ""}
          </li>
        ))}
      </ul>
      {overdue && (
        <p className="muted">
          An overdue job has stopped running. RUNBOOK section 11, scheduled-job-overdue, has the
          first checks.
        </p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className={`card stat ${value > 0 ? "error" : ""}`}>
      <strong>{value}</strong>
      <span className="muted">{label}</span>
    </div>
  );
}

/** Why the pipeline put a call in the queue, in words. Other flags are the summary's own notes. */
const REVIEW_REASONS: Record<string, string> = {
  "guardrail:price": "Named a price",
  "guardrail:commitment": "Promised a time",
  "guardrail:safety": "Gave safety advice",
  "judge:failed": "Summary doubted",
  extraction_failed: "No summary",
};

function ReviewQueue() {
  const { api } = useApi();
  const queue = useLoad(() => api<ReviewQueueView>("/admin/review-queue"), "review");
  // Pages loaded after the first, and calls marked reviewed since the first loaded. The pages
  // follow on from the last call shown, not a count, so marking calls doesn't shift them.
  const [more, setMore] = useState<ReviewQueueView | null>(null);
  const [reviewed, setReviewed] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);

  if (queue.status === "loading") return <p className="muted">Loading flagged calls…</p>;
  if (queue.status === "error") return <ErrorNote error={queue.error} retry={queue.reload} />;

  const calls = [...queue.data.calls, ...(more?.calls ?? [])].filter(
    (call) => !reviewed.has(call.callId),
  );
  const nextBefore = more ? more.nextBefore : queue.data.nextBefore;

  const markReviewed = async (callId: string) => {
    setBusy(callId);
    setError(null);
    try {
      await api<CallReviewedView>(`/admin/calls/${callId}/reviewed`, { method: "POST", body: {} });
      setReviewed((done) => new Set(done).add(callId));
    } catch (caught) {
      setError(asError(caught));
    } finally {
      setBusy(null);
    }
  };

  const loadMore = async () => {
    if (!nextBefore) return;
    setBusy("more");
    setError(null);
    try {
      const next = await api<ReviewQueueView>(
        `/admin/review-queue?before=${encodeURIComponent(nextBefore)}`,
      );
      setMore((list) => ({
        calls: [...(list?.calls ?? []), ...next.calls],
        nextBefore: next.nextBefore,
      }));
    } catch (caught) {
      setError(asError(caught));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section>
      <h2>Calls to review</h2>
      <p className="muted">
        Calls where the assistant may have named a price, promised a time or given safety advice of
        its own, or whose summary was doubted or failed. Newest first; mark each one reviewed once
        you've read it.
      </p>
      {error && <ErrorNote error={error} />}
      {calls.length === 0 && <p className="muted">Nothing to review.</p>}
      <ul className="list">
        {calls.map((call) => (
          <li key={call.callId} className="card">
            <Link to={`/tenants/${call.tenant.id}/calls/${call.callId}`} className="call-link">
              <div className="row">
                <span>
                  {formatUkDateTime(call.startedAt)} · {call.tenant.businessName}
                </span>
                <UrgencyBadge urgency={call.urgency} />
              </div>
              <p>
                {call.flags.map((flag) => (
                  <span key={flag} className={`badge ${REVIEW_REASONS[flag] ? "error" : "flag"}`}>
                    {REVIEW_REASONS[flag] ?? flag}
                  </span>
                ))}
              </p>
              <p className="summary">{call.summary ?? "No summary."}</p>
            </Link>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void markReviewed(call.callId)}
            >
              {busy === call.callId ? "Marking…" : "Mark reviewed"}
            </button>
          </li>
        ))}
      </ul>
      {nextBefore && (
        <button type="button" disabled={busy !== null} onClick={() => void loadMore()}>
          {busy === "more" ? "Loading…" : "Load more"}
        </button>
      )}
    </section>
  );
}

function Usage() {
  const { api } = useApi();
  const usage = useLoad(() => api<UsageView>("/admin/usage"), "usage");

  if (usage.status === "loading") return <p className="muted">Loading usage…</p>;
  if (usage.status === "error") return <ErrorNote error={usage.error} retry={usage.reload} />;

  return (
    <section>
      <h2>Usage this period</h2>
      <p className="muted">Billable call time per business. Prices come with billing.</p>
      <div className="table-wrap">
        <table className="usage">
          <thead>
            <tr>
              <th>Business</th>
              <th>Status</th>
              <th>Period</th>
              <th>Calls</th>
              <th>Billable time</th>
            </tr>
          </thead>
          <tbody>
            {usage.data.tenants.map((row) => (
              <tr key={row.tenantId}>
                <td>
                  <Link to={`/tenants/${row.tenantId}`}>{row.businessName}</Link>
                </td>
                <td>
                  <StatusBadge status={row.status} />
                </td>
                <td>{row.periodStart ? `From ${row.periodStart}` : "No calls yet"}</td>
                <td>{row.calls}</td>
                <td>{formatDuration(row.billableSeconds)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const COST_COLUMNS: { label: string; pick: (row: CostRowView) => number }[] = [
  { label: "Voice platform", pick: (row) => row.pence.voicePlatform },
  { label: "AI summaries", pick: (row) => row.pence.languageModel },
  { label: "Texts", pick: (row) => row.pence.texts },
  { label: "Phone minutes", pick: (row) => row.pence.phoneMinutes },
  { label: "Number", pick: (row) => row.pence.number },
  { label: "Total", pick: (row) => row.pence.total },
];

/** What each business cost us this month, estimated. Integer pence throughout, summed here too. */
function Costs() {
  const { api } = useApi();
  const costs = useLoad(() => api<CostsView>("/admin/costs"), "costs");

  if (costs.status === "loading") return <p className="muted">Loading costs…</p>;
  if (costs.status === "error") return <ErrorNote error={costs.error} retry={costs.reload} />;

  const { tenants, periodStart, assumptions, unpriced } = costs.data;
  const sum = (pick: (row: CostRowView) => number) =>
    tenants.reduce((total, row) => total + pick(row), 0);
  return (
    <section>
      <h2>Estimated costs this month</h2>
      <p className="muted">
        What each business's calls cost us since {periodStart}: an estimate from what the suppliers
        reported and today's price list, not a bill.
      </p>
      {unpriced.length > 0 && (
        <p className="card error">
          Not counted, because the price list doesn't cover them: {unpriced.join(", ")}.
        </p>
      )}
      <div className="table-wrap">
        <table className="usage">
          <thead>
            <tr>
              <th>Business</th>
              <th>Calls</th>
              {COST_COLUMNS.map((column) => (
                <th key={column.label}>{column.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tenants.map((row) => (
              <tr key={row.tenantId}>
                <td>
                  <Link to={`/tenants/${row.tenantId}`}>{row.businessName}</Link>
                </td>
                <td>{row.calls}</td>
                {COST_COLUMNS.map((column) => (
                  <td key={column.label}>{formatPence(column.pick(row))}</td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th>All businesses</th>
              <th>{sum((row) => row.calls)}</th>
              {COST_COLUMNS.map((column) => (
                <th key={column.label}>{formatPence(sum(column.pick))}</th>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
      <ul className="muted small">
        {assumptions.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Businesses that are leaving (BUILD_PLAN Step 13). For 30 days their callers hear "service has
 * ended"; after that their number can be released, which is a live action and final. Once it
 * has gone, their data can be deleted, which is final too, so the business's name is typed first.
 */
function Leaving() {
  const { api } = useApi();
  const leaving = useLoad(() => api<CancellationsView>("/admin/cancellations"), "cancellations");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [queued, setQueued] = useState<string[]>([]);

  if (leaving.status === "loading") return <p className="muted">Loading cancellations…</p>;
  if (leaving.status === "error") return <ErrorNote error={leaving.error} retry={leaving.reload} />;
  if (leaving.data.tenants.length === 0) return null;

  const release = async (tenantId: string, businessName: string, number: string | null) => {
    const what = number ? `Release ${formatPhone(number)}` : "Close";
    const question = `${what} for ${businessName}? The number goes back to Twilio for good, and callers to it stop hearing the "service has ended" message.`;
    if (!window.confirm(question)) return;
    setBusy(true);
    setError(null);
    try {
      await api<ReleasedNumberView>(`/admin/tenants/${tenantId}/release-number`, {
        method: "POST",
        body: { confirm: true },
      });
      leaving.reload();
    } catch (caught) {
      setError(asError(caught));
    } finally {
      setBusy(false);
    }
  };

  const deleteData = async (tenantId: string, businessName: string) => {
    const typed = window.prompt(
      `This deletes everything AnswerMate holds for ${businessName}: calls, recordings, transcripts, messages and contact details, here and at Retell and Twilio. Only the billing totals, the terms they accepted and the account log stay. It can't be undone.\n\nType the business's name to delete its data.`,
    );
    if (typed === null) return;
    setBusy(true);
    setError(null);
    try {
      await api<DataDeletionView>(`/admin/tenants/${tenantId}/delete-data`, {
        method: "POST",
        body: { confirm: true, businessName: typed },
      });
      setQueued((ids) => [...ids, tenantId]);
    } catch (caught) {
      setError(asError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2>Leaving businesses</h2>
      <p className="muted">
        Callers hear that the service has ended for 30 days after a cancellation. Then the number
        can be released, and after that the business's data deleted.
      </p>
      <ul className="list">
        {leaving.data.tenants.map((tenant) => (
          <li key={tenant.tenantId} className="card row">
            <div>
              <p className="row-title">
                <Link to={`/tenants/${tenant.tenantId}`}>{tenant.businessName}</Link>
              </p>
              <p className="muted">
                Cancelled {formatUkDateTime(tenant.cancellationRequestedAt)}
                {tenant.status === "cancelled"
                  ? " · number released, data still held"
                  : tenant.number
                    ? ` · ${formatPhone(tenant.number)}`
                    : " · no number"}
              </p>
            </div>
            {tenant.status === "cancelled" ? (
              queued.includes(tenant.tenantId) ? (
                <span className="muted">Deleting: the worker is on it</span>
              ) : (
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={() => void deleteData(tenant.tenantId, tenant.businessName)}
                >
                  Delete data
                </button>
              )
            ) : tenant.due ? (
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => void release(tenant.tenantId, tenant.businessName, tenant.number)}
              >
                {tenant.number ? "Release number" : "Close"}
              </button>
            ) : (
              <span className="muted">From {formatUkDateTime(tenant.releaseDueAt)}</span>
            )}
          </li>
        ))}
      </ul>
      {error && <ErrorNote error={error} />}
    </section>
  );
}
