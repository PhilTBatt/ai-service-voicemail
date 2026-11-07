// Phil's view of the whole service: is it healthy, which calls need a look, how much each
// business is using, and what that costs us. The API answers these only for the admin role; this page is just a view.
import type {
  CostRowView,
  CostsView,
  HealthView,
  KillSwitchView,
  ReviewQueueView,
  UsageView,
} from "@callmate/shared";
import { useState } from "react";
import { Link } from "react-router";
import { asError, useApi, useLoad } from "../api.ts";
import { formatDuration, formatPence } from "../format.ts";
import { formatUkDateTime } from "../time.ts";
import { ErrorNote, StatusBadge, UrgencyBadge } from "../ui.tsx";

export function AdminPage() {
  return (
    <>
      <h1>Admin</h1>
      <Health />
      <ReviewQueue />
      <Usage />
      <Costs />
    </>
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
      <div className="stats">
        <Stat label="Calls sent to voicemail" value={data.fallbackCalls} />
        <Stat label="Texts and emails that failed" value={data.failedNotifications} />
        <Stat label="Jobs that failed every retry" value={data.deadLetteredJobs24h} />
      </div>
      <p className="muted">Counts cover the last 24 hours.</p>
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

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className={`card stat ${value > 0 ? "error" : ""}`}>
      <strong>{value}</strong>
      <span className="muted">{label}</span>
    </div>
  );
}

function ReviewQueue() {
  const { api } = useApi();
  const queue = useLoad(() => api<ReviewQueueView>("/admin/review-queue"), "review");

  if (queue.status === "loading") return <p className="muted">Loading flagged calls…</p>;
  if (queue.status === "error") return <ErrorNote error={queue.error} retry={queue.reload} />;

  return (
    <section>
      <h2>Calls to review</h2>
      <p className="muted">
        Calls where the assistant may have quoted a price, promised a time, or summarised something
        the caller didn't say. Newest first.
      </p>
      {queue.data.calls.length === 0 && <p className="muted">Nothing flagged.</p>}
      <ul className="list">
        {queue.data.calls.map((call) => (
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
                  <span key={flag} className="badge flag">
                    {flag}
                  </span>
                ))}
              </p>
              <p className="summary">{call.summary ?? "No summary."}</p>
            </Link>
          </li>
        ))}
      </ul>
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
