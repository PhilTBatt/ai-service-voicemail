// How much each business is using this period, and what its calls cost us this month
// (estimated). Integer pence throughout, summed here too.
import type { CostRowView, CostsView, UsageView } from "@callmate/shared";
import { Link } from "react-router";
import { useApi, useLoad } from "../../api.ts";
import { Alert, Card, ErrorNote, Loading } from "../../design/components.tsx";
import { Gauge, Receipt } from "../../design/icons.ts";
import { formatDuration, formatPence } from "../../format.ts";
import { StatusBadge } from "../../ui.tsx";

export function AdminUsage() {
  return (
    <div className="stack stack-lg">
      <Usage />
      <Costs />
    </div>
  );
}

function Usage() {
  const { api } = useApi();
  const usage = useLoad(() => api<UsageView>("/admin/usage"), "usage");

  if (usage.status === "loading") return <Loading label="Loading usage…" />;
  if (usage.status === "error") return <ErrorNote error={usage.error} retry={usage.reload} />;

  return (
    <Card
      icon={Gauge}
      title="Usage this period"
      description="Billable call time per business, in each one's own billing month."
      flush
    >
      <div className="table-wrap">
        <table className="table table-stack">
          <thead>
            <tr>
              <th>Business</th>
              <th>Status</th>
              <th>Period</th>
              <th className="num">Calls</th>
              <th className="num">Billable time</th>
            </tr>
          </thead>
          <tbody>
            {usage.data.tenants.map((row) => (
              <tr key={row.tenantId}>
                <td data-label="">
                  <Link to={`/tenants/${row.tenantId}`}>
                    <strong>{row.businessName}</strong>
                  </Link>
                </td>
                <td data-label="Status">
                  <StatusBadge status={row.status} />
                </td>
                <td data-label="Period">
                  {row.periodStart ? `From ${row.periodStart}` : "No calls yet"}
                </td>
                <td data-label="Calls" className="num">
                  {row.calls}
                </td>
                <td data-label="Billable time" className="num">
                  {formatDuration(row.billableSeconds)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

const COST_COLUMNS: { label: string; pick: (row: CostRowView) => number }[] = [
  { label: "Voice platform", pick: (row) => row.pence.voicePlatform },
  { label: "AI summaries", pick: (row) => row.pence.languageModel },
  { label: "Texts", pick: (row) => row.pence.texts },
  { label: "Phone minutes", pick: (row) => row.pence.phoneMinutes },
  { label: "Number", pick: (row) => row.pence.number },
  { label: "Transcription", pick: (row) => row.pence.transcription },
  { label: "Total", pick: (row) => row.pence.total },
];

/** What each business cost us this month, estimated. */
function Costs() {
  const { api } = useApi();
  const costs = useLoad(() => api<CostsView>("/admin/costs"), "costs");

  if (costs.status === "loading") return <Loading label="Loading costs…" />;
  if (costs.status === "error") return <ErrorNote error={costs.error} retry={costs.reload} />;

  const { tenants, periodStart, assumptions, unpriced } = costs.data;
  const sum = (pick: (row: CostRowView) => number) =>
    tenants.reduce((total, row) => total + pick(row), 0);
  return (
    <Card
      icon={Receipt}
      title="Estimated costs this month"
      description={`What each business's calls cost us since ${periodStart}: an estimate from what the suppliers reported and today's price list, not a bill.`}
      flush
      footer={
        <ul className="stack stack-xs muted text-xs">
          {assumptions.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      }
    >
      {unpriced.length > 0 && (
        <div className="card-body">
          <Alert tone="warning">
            <p>Not counted, because the price list doesn't cover them: {unpriced.join(", ")}.</p>
          </Alert>
        </div>
      )}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Business</th>
              <th className="num">Calls</th>
              {COST_COLUMNS.map((column) => (
                <th key={column.label} className="num">
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tenants.map((row) => (
              <tr key={row.tenantId}>
                <td>
                  <Link to={`/tenants/${row.tenantId}`}>{row.businessName}</Link>
                </td>
                <td className="num">{row.calls}</td>
                {COST_COLUMNS.map((column) => (
                  <td key={column.label} className="num">
                    {formatPence(column.pick(row))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th>All businesses</th>
              <th className="num">{sum((row) => row.calls)}</th>
              {COST_COLUMNS.map((column) => (
                <th key={column.label} className="num">
                  {formatPence(sum(column.pick))}
                </th>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  );
}
