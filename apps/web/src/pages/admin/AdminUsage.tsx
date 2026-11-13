// What the service uses and what it costs (all estimated, never a bill): the headline figures,
// tier changes on the way, how fast use is growing, every supplier with its plan and tiers, and
// each business's costs beside its bill so far. Integer pence throughout, summed here too.
import type {
  AccountReadingsView,
  CostRowView,
  CostsView,
  ServiceCostView,
  UsageView,
} from "@callmate/shared";
import { Link } from "react-router";
import { useApi, useLoad } from "../../api.ts";
import {
  businessMargin,
  emailCountText,
  estimateGap,
  percentOf,
  costHeadlines,
  penceChange,
  rankedServices,
  rateLabel,
  tierWarnings,
  usageLabel,
} from "../../costs.ts";
import {
  Alert,
  Badge,
  BarList,
  Card,
  ErrorNote,
  Loading,
  Meter,
  Stat,
} from "../../design/components.tsx";
import { Activity, Gauge, Receipt } from "../../design/icons.ts";
import { formatDuration, formatPence } from "../../format.ts";
import { addDays, formatDate } from "../../time.ts";
import { StatusBadge } from "../../ui.tsx";

export function AdminUsage() {
  return (
    <div className="stack stack-lg">
      <Costs />
      <Usage />
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

/** Everything about costs: one load, laid out in sections. */
function Costs() {
  const { api } = useApi();
  const costs = useLoad(() => api<CostsView>("/admin/costs"), "costs");

  if (costs.status === "loading") return <Loading label="Loading costs…" />;
  if (costs.status === "error") return <ErrorNote error={costs.error} retry={costs.reload} />;

  const { suppliers, tenants, assumptions, unpriced } = costs.data;
  const warnings = tierWarnings(suppliers.services);
  return (
    <>
      <section className="stack" aria-labelledby="cost-headlines">
        <div className="stack stack-xs">
          <h2 id="cost-headlines">Costs at a glance</h2>
          <p className="muted text-sm">
            The last {suppliers.windowDays} days, {formatDate(suppliers.from)} to{" "}
            {formatDate(suppliers.to)}, against the {suppliers.windowDays} before. Estimates from
            our own records and each supplier's price list: not a bill.
          </p>
        </div>
        <div className="grid grid-stats">
          {costHeadlines(suppliers.totals).map((headline) => (
            <Stat
              key={headline.key}
              label={headline.label}
              value={headline.value}
              hint={headline.hint}
              tone={headline.tone}
            />
          ))}
        </div>
      </section>

      <Card
        title="Tier changes on the way"
        description="Where the next 30 days would cross a plan's limit, or fit a cheaper one."
      >
        {warnings.length === 0 ? (
          <p className="muted">Nothing is close to a limit, and no cheaper plan would fit.</p>
        ) : (
          <div className="stack stack-sm">
            {warnings.map((warning) => (
              <Alert
                key={warning.id}
                tone={warning.direction === "up" ? "warning" : "success"}
                title={`${warning.name}: ${warning.direction === "up" ? "costs or limits ahead" : "a saving"}`}
              >
                <p>{warning.text}</p>
              </Alert>
            ))}
          </div>
        )}
      </Card>

      <Accounts accounts={suppliers.accounts} />

      <Growth growth={suppliers.growth} days={suppliers.windowDays} />

      <Card
        icon={Receipt}
        title="Suppliers"
        description={`What each one cost over the last ${suppliers.windowDays} days, dearest first.`}
      >
        <BarList
          items={rankedServices(suppliers.services)}
          label="Cost by supplier, last 30 days"
        />
      </Card>

      <Card
        title="Every supplier, its plan and its tiers"
        description="The plan we're on, what's used of it, and where its cost is heading. Open a supplier for its tiers."
        flush
      >
        <div className="table-wrap">
          <table className="table table-stack">
            <thead>
              <tr>
                <th>Supplier</th>
                <th>Plan</th>
                <th>Used</th>
                <th className="num">Last 30 days</th>
                <th className="num">Next 30 days</th>
                <th className="num">Change</th>
              </tr>
            </thead>
            <tbody>
              {suppliers.services.map((service) => (
                <SupplierRow key={service.id} service={service} />
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th colSpan={3}>All suppliers</th>
                <th className="num">{formatPence(suppliers.totals.nowPence)}</th>
                <th className="num">{formatPence(suppliers.totals.nextPence)}</th>
                <th className="num">
                  {penceChange(suppliers.totals.nowPence, suppliers.totals.nextPence).label}
                </th>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>

      <Businesses
        tenants={tenants}
        calendarStart={costs.data.periodStart}
        assumptions={assumptions}
        unpriced={unpriced}
      />
    </>
  );
}

function SupplierRow({ service }: { service: ServiceCostView }) {
  const change = penceChange(service.pence.now, service.pence.next);
  return (
    <tr>
      <td data-label="">
        <details>
          <summary>
            <strong>{service.name}</strong>
          </summary>
          <p className="muted text-sm">{service.purpose}.</p>
          <p className="text-sm">{service.pricing}</p>
          <p className="muted text-xs">Its cost moves with: {service.drivenBy.toLowerCase()}.</p>
          <ul className="tier-list" aria-label={`${service.name} tiers`}>
            {service.tiers.map((tier) => (
              <li key={tier.name} data-current={tier.current}>
                <span>
                  <strong>{tier.name}</strong>
                  {tier.current && " (current)"}
                </span>
                <span className="muted">{tier.limit}</span>
                <span className="num">
                  {tier.monthlyPence === null
                    ? "By agreement"
                    : tier.monthlyPence === 0
                      ? "No monthly fee"
                      : `${formatPence(tier.monthlyPence)} a month`}
                </span>
              </li>
            ))}
          </ul>
        </details>
      </td>
      <td data-label="Plan">
        {service.plan}
        {service.warnings.length > 0 && (
          <>
            {" "}
            <Badge
              tone={
                service.warnings.some((each) => each.direction === "up") ? "warning" : "success"
              }
            >
              {service.warnings.some((each) => each.direction === "up") ? "Watch" : "Saving"}
            </Badge>
          </>
        )}
      </td>
      <td data-label="Used">
        {service.usage ? (
          <div className="stack stack-xs">
            <span className="text-sm">
              {service.usage.label}: {usageLabel(service.usage)}
            </span>
            {service.usage.limit !== null && (
              <Meter
                value={service.usage.used}
                max={service.usage.limit}
                label={`${service.name}: ${usageLabel(service.usage)}`}
              />
            )}
          </div>
        ) : (
          <span className="muted">Nothing to measure</span>
        )}
      </td>
      <td data-label="Last 30 days" className="num">
        <div className="stack stack-xs">
          <span>{formatPence(service.pence.now)}</span>
          {service.measured && <span className="muted text-xs">Its own figure</span>}
        </div>
      </td>
      <td data-label="Next 30 days" className="num">
        {formatPence(service.pence.next)}
      </td>
      <td data-label="Change" className="num">
        {change.tone === "neutral" ? (
          <span className="muted">{change.label}</span>
        ) : (
          <Badge tone={change.tone}>{change.label}</Badge>
        )}
      </td>
    </tr>
  );
}

function Growth({ growth, days }: { growth: CostsView["suppliers"]["growth"]; days: number }) {
  const rows = [
    { label: "Calls", trend: growth.calls },
    { label: "Call minutes", trend: growth.minutes },
    { label: "Emails", trend: growth.emails },
    { label: "Text segments", trend: growth.textSegments },
  ];
  return (
    <Card
      icon={Activity}
      title="How fast use is growing"
      description={`Each ${days} days against the ${days} before, and the same step again for the next ${days}: a straight line, so one busy week moves it.`}
      flush
    >
      <div className="table-wrap">
        <table className="table table-stack">
          <thead>
            <tr>
              <th>Measure</th>
              <th className="num">{days} days before</th>
              <th className="num">Last {days} days</th>
              <th className="num">Change</th>
              <th className="num">Next {days} days</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ label, trend }) => (
              <tr key={label}>
                <td data-label="">
                  <strong>{label}</strong>
                </td>
                <td data-label="Before" className="num">
                  {trend.previous.toLocaleString("en-GB")}
                </td>
                <td data-label="Last" className="num">
                  {trend.last.toLocaleString("en-GB")}
                </td>
                <td data-label="Change" className="num">
                  {rateLabel(trend)}
                </td>
                <td data-label="Next" className="num">
                  {trend.next.toLocaleString("en-GB")}
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
  { label: "Call texts", pick: (row) => row.pence.texts },
  { label: "Account texts", pick: (row) => row.pence.accountTexts },
  { label: "Phone minutes", pick: (row) => row.pence.phoneMinutes },
  { label: "Number", pick: (row) => row.pence.number },
  { label: "Transcription", pick: (row) => row.pence.transcription },
  { label: "Total cost", pick: (row) => row.pence.total },
];

/** What each business cost us in its month so far, beside what that month comes to. */
function Businesses({
  tenants,
  calendarStart,
  assumptions,
  unpriced,
}: {
  tenants: CostRowView[];
  calendarStart: string;
  assumptions: string[];
  unpriced: string[];
}) {
  const sum = (pick: (row: CostRowView) => number) =>
    tenants.reduce((total, row) => total + pick(row), 0);
  const billed = tenants.filter((row) => row.billPence !== null);
  const billTotal = sum((row) => row.billPence ?? 0);
  const marginTotal = billed.reduce((total, row) => total + (businessMargin(row) ?? 0), 0);
  return (
    <Card
      icon={Receipt}
      title="Each business: its costs and its bill so far"
      description={`A live business is costed over its own billing month so far, the same days as its bill; the rest over the calendar month from ${formatDate(calendarStart)}.`}
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
              <th>Month</th>
              <th className="num">Calls</th>
              {COST_COLUMNS.map((column) => (
                <th key={column.label} className="num">
                  {column.label}
                </th>
              ))}
              <th className="num">Bill so far</th>
              <th className="num">Bill less cost</th>
            </tr>
          </thead>
          <tbody>
            {tenants.map((row) => {
              const margin = businessMargin(row);
              return (
                <tr key={row.tenantId}>
                  <td>
                    <Link to={`/tenants/${row.tenantId}`}>{row.businessName}</Link>
                  </td>
                  <td>
                    {formatDate(row.windowStart)} to {formatDate(addDays(row.windowEnd, -1))}
                  </td>
                  <td className="num">{row.calls}</td>
                  {COST_COLUMNS.map((column) => (
                    <td key={column.label} className="num">
                      {formatPence(column.pick(row))}
                    </td>
                  ))}
                  <td className="num">
                    {row.billPence === null ? (
                      <span className="muted">Doesn't pay</span>
                    ) : (
                      formatPence(row.billPence)
                    )}
                  </td>
                  <td className="num">
                    {margin === null ? <span className="muted">–</span> : formatPence(margin)}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={2}>All businesses</th>
              <th className="num">{sum((row) => row.calls)}</th>
              {COST_COLUMNS.map((column) => (
                <th key={column.label} className="num">
                  {formatPence(sum(column.pick))}
                </th>
              ))}
              <th className="num">{formatPence(billTotal)}</th>
              <th className="num">{formatPence(marginTotal)}</th>
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  );
}

/** What Twilio's and Postmark's own accounts say, beside our estimates. */
function Accounts({ accounts }: { accounts: AccountReadingsView }) {
  const { twilio, postmark } = accounts;
  return (
    <Card
      title="From your accounts"
      description={`What Twilio and Postmark say themselves for ${formatDate(accounts.from)} to ${formatDate(accounts.to)}, read as this page opened. Where they're read, their figures are used above in place of ours.`}
    >
      <div className="stack">
        <section className="stack stack-sm" aria-labelledby="account-twilio">
          <h3 id="account-twilio">Twilio</h3>
          {twilio.status === "read" ? (
            <>
              <p>
                <strong className="num">{formatPence(twilio.totalPence)}</strong> by Twilio's own
                total, {estimateGap(twilio.totalPence, twilio.estimatePence)} (
                {formatPence(twilio.estimatePence)}).
              </p>
              {twilio.lines.length > 0 && (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>What</th>
                        <th className="num">Used</th>
                        <th className="num">Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {twilio.lines.map((line) => (
                        <tr key={line.category}>
                          <td>{line.description}</td>
                          <td className="num">{line.usage}</td>
                          <td className="num">{formatPence(line.pence)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="muted text-xs">
                The total includes anything not listed. The account's balance isn't shown: Twilio's
                docs don't describe a way to read it.
              </p>
            </>
          ) : (
            <Unread reading={twilio} />
          )}
        </section>

        <section className="stack stack-sm" aria-labelledby="account-postmark">
          <h3 id="account-postmark">Postmark</h3>
          {postmark.status === "read" ? (
            <>
              <p>
                <strong className="num">{postmark.sent}</strong> emails sent, against{" "}
                {postmark.previousSent} in the 30 days before.{" "}
                {emailCountText(postmark.sent, postmark.ourCount)}
              </p>
              <ul className="stack stack-xs text-sm">
                <li>
                  Bounced: {postmark.bounced} ({percentOf(postmark.bounced, postmark.sent)}).
                  Postmark pauses an account past 10%.
                </li>
                <li>
                  Reported as spam: {postmark.spamComplaints} (
                  {percentOf(postmark.spamComplaints, postmark.sent)}). Postmark pauses an account
                  past 1 in 1,000.
                </li>
              </ul>
            </>
          ) : (
            <Unread reading={postmark} />
          )}
        </section>
      </div>
    </Card>
  );
}

function Unread({ reading }: { reading: { status: "off" | "failed"; reason: string } }) {
  return reading.status === "off" ? (
    <p className="muted">{reading.reason}, so the figures above are our estimates.</p>
  ) : (
    <Alert tone="warning">
      <p>
        Couldn't read it this time: {reading.reason}. The figures above are our estimates until it
        can be.
      </p>
    </Alert>
  );
}
