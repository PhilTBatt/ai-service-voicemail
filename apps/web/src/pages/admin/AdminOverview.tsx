// The Admin overview: is the service healthy (the kill switch, the worker, the scheduled jobs,
// anything that failed in the last day), and which calls need a look.
import type {
  CallReviewedView,
  HealthView,
  KillSwitchView,
  ReviewQueueView,
} from "@callmate/shared";
import { useState } from "react";
import { Link } from "react-router";
import { asError, useApi, useLoad } from "../../api.ts";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Loading,
  SectionHeader,
  Stat,
} from "../../design/components.tsx";
import { useConfirm } from "../../design/dialog.tsx";
import {
  Activity,
  Check,
  CircleCheck,
  Clock,
  Mail,
  Power,
  TriangleAlert,
  Voicemail,
} from "../../design/icons.ts";
import { useToast } from "../../design/toast.tsx";
import { formatUkDateTime } from "../../time.ts";
import { UrgencyBadge } from "../../ui.tsx";

export function AdminOverview() {
  return (
    <div className="stack stack-xl">
      <Health />
      <ReviewQueue />
    </div>
  );
}

function Health() {
  const { api } = useApi();
  const confirm = useConfirm();
  const toast = useToast();
  const health = useLoad(() => api<HealthView>("/admin/health"), "health");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  if (health.status === "loading") return <Loading label="Loading health…" lines={4} />;
  if (health.status === "error") return <ErrorNote error={health.error} retry={health.reload} />;

  const data = health.data;
  const flip = async () => {
    const yes = await confirm(
      data.killSwitchOn
        ? {
            title: "Turn the kill switch off?",
            body: "Calls go back to the assistant, for every business.",
            confirmLabel: "Turn off",
          }
        : {
            title: "Turn the kill switch on?",
            body: "Every caller on every number goes straight to voicemail until you turn it off.",
            confirmLabel: "Turn on",
            tone: "danger",
          },
    );
    if (!yes) return;
    setBusy(true);
    setError(null);
    try {
      await api<KillSwitchView>("/admin/kill-switch", {
        method: "PUT",
        body: { on: !data.killSwitchOn },
      });
      toast({ title: data.killSwitchOn ? "Kill switch off" : "Kill switch on" });
      health.reload();
    } catch (caught) {
      setError(asError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="stack" aria-labelledby="health-heading">
      <SectionHeader title={<span id="health-heading">Health</span>} />
      <section
        className="card answering"
        data-tone={data.killSwitchOn ? "danger" : "success"}
        aria-label="Kill switch"
      >
        <div className="answering-state">
          <span className="pulse" data-live={!data.killSwitchOn} aria-hidden="true" />
          <p>
            <strong>Kill switch is {data.killSwitchOn ? "ON" : "off"}.</strong>{" "}
            <span className="muted">
              {data.killSwitchOn
                ? "Every call goes to voicemail."
                : "Calls go to each business's assistant."}
            </span>
          </p>
        </div>
        <Button
          variant={data.killSwitchOn ? "primary" : "danger"}
          icon={Power}
          loading={busy}
          onClick={() => void flip()}
        >
          {data.killSwitchOn ? "Turn off" : "Turn on"}
        </Button>
        {error && <ErrorNote error={error} />}
      </section>

      <Worker worker={data.worker} />

      <div className="grid grid-stats">
        {/* Voicemails left, not plays: a caller who hangs up at the greeting isn't counted (the
          fallback-voicemail-spike alert counts every play). */}
        <Stat
          icon={Voicemail}
          label="Voicemails left"
          value={data.fallbackCalls}
          tone={data.fallbackCalls > 0 ? "warning" : undefined}
          hint="Last 24 hours"
        />
        <Stat
          icon={Mail}
          label="Texts and emails that failed"
          value={data.failedNotifications}
          tone={data.failedNotifications > 0 ? "danger" : undefined}
          hint="Last 24 hours"
        />
        <Stat
          icon={TriangleAlert}
          label="Jobs that failed every retry"
          value={data.deadLetteredJobs24h}
          tone={data.deadLetteredJobs24h > 0 ? "danger" : undefined}
          hint="Last 24 hours"
        />
      </div>

      <ScheduledJobs jobs={data.scheduledJobs} />

      {data.failedNotificationsRecent.length > 0 && (
        <Card
          tone="danger"
          title="Texts and emails that couldn't be sent"
          description={`Newest first. "Failed" is the provider refusing the send, with its reason; "undelivered" is the carrier's verdict afterwards, with its code.`}
        >
          <ul className="stack stack-sm">
            {data.failedNotificationsRecent.map((failed) => (
              <li key={`${failed.callId}:${failed.channel}`} className="text-sm">
                <span className="muted">{formatUkDateTime(failed.at)}</span>{" "}
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
        </Card>
      )}
      {data.deadLetteredJobsRecent.length > 0 && (
        <Card
          tone="danger"
          title="Jobs that failed every retry"
          description="Newest first, with the error that ended the last attempt."
        >
          <ul className="stack stack-sm">
            {data.deadLetteredJobsRecent.map((job, index) => (
              <li key={`${job.at}:${index}`} className="text-sm">
                <span className="muted">{formatUkDateTime(job.at)}</span> <code>{job.queue}</code>
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
        </Card>
      )}
      {data.waitingSyncs.length > 0 && (
        <Card
          tone="warning"
          title="Assistants waiting to be updated"
          description="Saved over five minutes ago, and nothing has synced them yet: is the worker running?"
        >
          <ul className="stack stack-sm">
            {data.waitingSyncs.map((sync) => (
              <li key={sync.tenantId} className="text-sm">
                <Link to={`/tenants/${sync.tenantId}/profile`}>{sync.businessName}</Link>, version{" "}
                {sync.version}, saved {formatUkDateTime(sync.savedAt)}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {data.failedSyncs.length > 0 && (
        <Card tone="danger" title="Assistants that couldn't be updated">
          <ul className="stack stack-sm">
            {data.failedSyncs.map((sync) => (
              <li key={sync.tenantId} className="text-sm">
                <Link to={`/tenants/${sync.tenantId}/profile`}>{sync.businessName}</Link>, version{" "}
                {sync.version}: {sync.error}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}

/** Whether anything is running the jobs: syncs, summaries, texts and emails. */
function Worker({ worker }: { worker: HealthView["worker"] }) {
  if (worker.state === "running") {
    return (
      <Alert tone="success" icon={Activity}>
        <p>The worker is running: it last checked in at {formatUkDateTime(worker.lastSeen!)}.</p>
      </Alert>
    );
  }
  return (
    <Alert
      tone="danger"
      title={
        worker.state === "never"
          ? "No worker has checked in yet."
          : `The worker hasn't checked in since ${formatUkDateTime(worker.lastSeen!)}.`
      }
    >
      <p>
        Until one runs, assistants aren't updated and no call summaries, texts or emails go out.
        Check the worker's logs (locally, start it with npm run worker).
      </p>
    </Alert>
  );
}

/**
 * The recurring jobs: when each last ran, and which have stopped. A failure shows only when it's
 * newer than the last success (an older one has been put right since).
 */
function ScheduledJobs({ jobs }: { jobs: HealthView["scheduledJobs"] }) {
  const overdue = jobs.some((job) => job.overdue);
  return (
    <Card
      icon={Clock}
      tone={overdue ? "danger" : undefined}
      title="Scheduled jobs"
      description={
        overdue
          ? "An overdue job has stopped running. RUNBOOK section 11, scheduled-job-overdue, has the first checks."
          : undefined
      }
      flush
    >
      {jobs.length === 0 ? (
        <EmptyState icon={Clock} title="No scheduled job has run yet." />
      ) : (
        <div className="table-wrap">
          <table className="table table-stack">
            <thead>
              <tr>
                <th>Job</th>
                <th>Last ran</th>
                <th>Last failed</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => {
                const failedSince =
                  job.lastFailedAt !== null &&
                  (!job.lastSucceededAt || job.lastFailedAt > job.lastSucceededAt);
                return (
                  <tr key={job.queue}>
                    <td data-label="">
                      <strong>{job.label}</strong>
                    </td>
                    <td data-label="Last ran">
                      {job.lastSucceededAt ? formatUkDateTime(job.lastSucceededAt) : "Not yet"}
                    </td>
                    <td data-label="Last failed">
                      {failedSince ? formatUkDateTime(job.lastFailedAt!) : "—"}
                    </td>
                    <td data-label="State">
                      {job.overdue ? (
                        <Badge tone="danger">Overdue</Badge>
                      ) : failedSince ? (
                        <Badge tone="warning">Failed last time</Badge>
                      ) : (
                        <Badge tone="success" icon={CircleCheck}>
                          On time
                        </Badge>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
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

  const header = (
    <SectionHeader
      title={<span id="review-heading">Calls to review</span>}
      description="Calls where the assistant may have named a price, promised a time or given safety advice of its own, or whose summary was doubted or failed. Newest first; mark each one reviewed once you've read it."
    />
  );
  if (queue.status === "loading") {
    return (
      <section className="stack" aria-labelledby="review-heading">
        {header}
        <Loading label="Loading flagged calls…" />
      </section>
    );
  }
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
    <section className="stack" aria-labelledby="review-heading">
      {header}
      {error && <ErrorNote error={error} />}
      <Card flush>
        {calls.length === 0 ? (
          <EmptyState icon={CircleCheck} title="Nothing to review.">
            Flagged calls appear here as they come in.
          </EmptyState>
        ) : (
          <ul className="list list-divided">
            {calls.map((call) => (
              <li key={call.callId} className="list-item">
                <div className="stack stack-sm list-item-main">
                  <div className="cluster text-sm">
                    <Link to={`/tenants/${call.tenant.id}/calls/${call.callId}`}>
                      {formatUkDateTime(call.startedAt)} · {call.tenant.businessName}
                    </Link>
                    <UrgencyBadge urgency={call.urgency} />
                  </div>
                  <div className="cluster">
                    {call.flags.map((flag) => (
                      <Badge key={flag} tone={REVIEW_REASONS[flag] ? "danger" : "neutral"}>
                        {REVIEW_REASONS[flag] ?? flag}
                      </Badge>
                    ))}
                  </div>
                  <p>{call.summary ?? "No summary."}</p>
                </div>
                <Button
                  variant="secondary"
                  icon={Check}
                  loading={busy === call.callId}
                  disabled={busy !== null}
                  onClick={() => void markReviewed(call.callId)}
                >
                  Mark reviewed
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {nextBefore && (
        <Button
          variant="secondary"
          block
          loading={busy === "more"}
          disabled={busy !== null}
          onClick={() => void loadMore()}
        >
          Load more
        </Button>
      )}
    </section>
  );
}
