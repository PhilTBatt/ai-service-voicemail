// One business's calls: whether the assistant is answering (and the switch), then the calls,
// newest first, grouped by UK day, filterable by urgency, by UK date and by whether they still
// need a reply, fifty at a time.
import {
  URGENCIES,
  type CallListView,
  type CallSummaryView,
  type SwitchView,
  type TenantView,
} from "@callmate/shared";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { asError, useApi } from "../api.ts";
import {
  callsQuery,
  filtersFromSearch,
  NO_FILTERS,
  searchFromFilters,
  type CallFilters,
} from "../calls-query.ts";
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Loading,
  Segmented,
  SectionHeader,
  TextField,
  ToggleChip,
} from "../design/components.tsx";
import { useConfirm } from "../design/dialog.tsx";
import { Check, Inbox, MessageSquare, Power, RotateCcw, Voicemail } from "../design/icons.ts";
import { useToast } from "../design/toast.tsx";
import { formatDurationWords, formatPhone, urgencyLabel, urgencyTone } from "../format.ts";
import { useTenant } from "../tenant-layout.tsx";
import { dayLabel, formatUkTime, ukDate } from "../time.ts";
import { UrgencyBadge } from "../ui.tsx";

export function TenantPage() {
  const { tenant, reload } = useTenant();
  return (
    <>
      <AnsweringSwitch tenant={tenant} onChanged={reload} />
      <Calls tenantId={tenant.id} />
    </>
  );
}

/**
 * Whether the assistant is answering, and the switch. On and off are only for a live or paused
 * business; for any other status the card says why it isn't answering, with no switch.
 */
function AnsweringSwitch({ tenant, onChanged }: { tenant: TenantView; onChanged: () => void }) {
  const { api } = useApi();
  const confirm = useConfirm();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const switchable = tenant.status === "live" || tenant.status === "paused";
  const on = tenant.status === "live";

  const flip = async () => {
    const yes = await confirm(
      on
        ? {
            title: "Switch AnswerMate off?",
            body: "Callers will go to voicemail until you switch it back on. You'll still get a text for each voicemail.",
            confirmLabel: "Switch off",
            tone: "danger",
          }
        : {
            title: "Switch AnswerMate back on?",
            body: "The assistant starts answering your diverted calls again straight away.",
            confirmLabel: "Switch on",
          },
    );
    if (!yes) return;
    setBusy(true);
    setError(null);
    try {
      await api<SwitchView>(`/tenants/${tenant.id}/switch`, { method: "PUT", body: { on: !on } });
      toast({ title: on ? "AnswerMate is off" : "AnswerMate is on" });
      onChanged();
    } catch (caught) {
      setError(asError(caught));
    } finally {
      setBusy(false);
    }
  };

  const state = !switchable
    ? notAnsweringReason(tenant.status)
    : on
      ? { tone: "success" as const, title: "AnswerMate is on", text: "Answering your calls." }
      : { tone: "warning" as const, title: "AnswerMate is off", text: "Callers go to voicemail." };
  if (!state) return null;

  return (
    <section className="card answering" data-tone={state.tone} aria-label="Answering">
      <div className="answering-state">
        <span className="pulse" data-live={on} aria-hidden="true" />
        <p>
          <strong>{state.title}</strong> <span className="muted">{state.text}</span>
        </p>
      </div>
      {switchable && (
        <Button
          variant={on ? "secondary" : "primary"}
          icon={Power}
          loading={busy}
          onClick={() => void flip()}
        >
          {on ? "Switch off" : "Switch on"}
        </Button>
      )}
      {error && <ErrorNote error={error} />}
    </section>
  );
}

function notAnsweringReason(status: string) {
  switch (status) {
    case "onboarding":
      return {
        tone: "info" as const,
        title: "Not answering yet.",
        text: "AnswerMate starts answering once setup is finished.",
      };
    case "suspended":
      return {
        tone: "danger" as const,
        title: "Suspended.",
        text: "Callers go to voicemail. Please get in touch with us to sort it out.",
      };
    case "cancelling":
    case "cancelled":
      return {
        tone: "neutral" as const,
        title: "AnswerMate has been cancelled.",
        text: "Callers hear that the service has ended.",
      };
    default:
      return null;
  }
}

interface CallPages {
  calls: CallSummaryView[];
  nextBefore: string | null;
}

const URGENCY_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "All" },
  ...URGENCIES.map((urgency) => ({ value: urgency, label: urgencyLabel(urgency) })),
];

function Calls({ tenantId }: { tenantId: string }) {
  const { api } = useApi();
  // The filters live in the page's address, so they're still set after opening a call and
  // coming back to the list.
  const [search, setSearch] = useSearchParams();
  const filters = filtersFromSearch(search);
  const setFilters = (next: CallFilters) => setSearch(searchFromFilters(next), { replace: true });
  const [pages, setPages] = useState<CallPages | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const query = callsQuery(filters);
  // Which list is on screen now, so a page that arrives for an earlier filter is dropped.
  const shown = useRef(`${tenantId}?${query}`);
  useEffect(() => {
    shown.current = `${tenantId}?${query}`;
  }, [tenantId, query]);

  // A new filter starts again from the newest call.
  useEffect(() => {
    let current = true;
    setPages(null);
    setError(null);
    void api<CallListView>(`/tenants/${tenantId}/calls?${query}`).then(
      (first) => {
        if (current) setPages(first);
      },
      (caught: unknown) => {
        if (current) setError(asError(caught));
      },
    );
    return () => {
      current = false;
    };
    // Not `api`: it may be a new function on each render, and only these two mean new calls.
  }, [tenantId, query]);

  const loadMore = async () => {
    if (!pages?.nextBefore) return;
    const asked = `${tenantId}?${query}`;
    setLoadingMore(true);
    try {
      const next = await api<CallListView>(
        `/tenants/${tenantId}/calls?${callsQuery(filters, pages.nextBefore)}`,
      );
      if (shown.current !== asked) return; // the filter changed while it loaded
      setPages((list) =>
        list ? { calls: [...list.calls, ...next.calls], nextBefore: next.nextBefore } : list,
      );
    } catch (caught) {
      setError(asError(caught));
    } finally {
      setLoadingMore(false);
    }
  };

  const set = (change: Partial<CallFilters>) => setFilters({ ...filters, ...change });
  const filtered = query !== "";
  const listSearch = searchFromFilters(filters).toString();

  return (
    <section className="stack" aria-labelledby="calls-heading">
      <div className="stack stack-sm">
        <SectionHeader
          title={<span id="calls-heading">Calls</span>}
          actions={
            filtered && (
              <Button
                variant="ghost"
                size="sm"
                icon={RotateCcw}
                onClick={() => setFilters(NO_FILTERS)}
              >
                Clear filters
              </Button>
            )
          }
        />
        <div className="toolbar">
          <Segmented
            label="Urgency"
            options={URGENCY_OPTIONS}
            value={filters.urgency}
            onChange={(urgency) => set({ urgency })}
          />
          <ToggleChip
            pressed={filters.needsReply}
            icon={MessageSquare}
            onChange={(needsReply) => set({ needsReply })}
          >
            Needs a reply
          </ToggleChip>
          <div className="toolbar-group">
            <TextField
              label="From"
              type="date"
              className="input-auto"
              value={filters.from}
              onChange={(event) => set({ from: event.target.value })}
            />
            <TextField
              label="To"
              type="date"
              className="input-auto"
              value={filters.to}
              onChange={(event) => set({ to: event.target.value })}
            />
          </div>
        </div>
      </div>

      {error && <ErrorNote error={error} />}
      {!pages && !error && (
        <div className="card card-body">
          <Loading label="Loading calls…" lines={4} />
        </div>
      )}
      {pages && pages.calls.length === 0 && (
        <div className="card">
          {filtered ? (
            <EmptyState
              icon={Inbox}
              title="No calls match"
              action={
                <Button variant="secondary" onClick={() => setFilters(NO_FILTERS)}>
                  Clear filters
                </Button>
              }
            >
              Try another urgency or dates.
            </EmptyState>
          ) : (
            <EmptyState icon={Inbox} title="No calls yet">
              When AnswerMate answers a call, it appears here, and you get a text about it.
            </EmptyState>
          )}
        </div>
      )}
      {pages && pages.calls.length > 0 && (
        <div>
          {groupByDay(pages.calls).map(({ day, label, calls }) => (
            <section key={day} className="day-group">
              <h3 className="day-heading">{label}</h3>
              <Card flush>
                <ul className="list list-divided">
                  {calls.map((call) => (
                    <CallRow
                      key={call.callId}
                      tenantId={tenantId}
                      call={call}
                      listSearch={listSearch}
                    />
                  ))}
                </ul>
              </Card>
            </section>
          ))}
        </div>
      )}
      {pages?.nextBefore && (
        <Button variant="secondary" block loading={loadingMore} onClick={() => void loadMore()}>
          Show older calls
        </Button>
      )}
    </section>
  );
}

/** Calls in their UK days, newest day first, keeping the list's order within each. */
function groupByDay(calls: CallSummaryView[]) {
  const groups: { day: string; label: string; calls: CallSummaryView[] }[] = [];
  for (const call of calls) {
    const day = ukDate(new Date(call.startedAt));
    const last = groups.at(-1);
    if (last?.day === day) last.calls.push(call);
    else groups.push({ day, label: dayLabel(call.startedAt), calls: [call] });
  }
  return groups;
}

function CallRow({
  tenantId,
  call,
  listSearch,
}: {
  tenantId: string;
  call: CallSummaryView;
  /** The list's filters, so the call page's "All calls" comes back to the same list. */
  listSearch: string;
}) {
  const number = call.fields.callbackNumber ?? call.callerNumber;
  return (
    <li className="call-row">
      <Link to={`/tenants/${tenantId}/calls/${call.callId}`} state={{ listSearch }}>
        <Avatar name={call.fields.callerName} tone={urgencyTone(call.urgency)} />
        <div className="call-main">
          <div className="call-top">
            <span className="call-who">
              {call.fields.callerName ?? "Unknown caller"}
              {number && <span className="call-number"> · {formatPhone(number)}</span>}
            </span>
            <span className="call-time">
              {formatUkTime(call.startedAt)} · {formatDurationWords(call.durationSeconds)}
            </span>
          </div>
          <p className="call-summary">{call.summary ?? "No summary yet."}</p>
          <div className="call-tags">
            <UrgencyBadge urgency={call.urgency} />
            {call.handledAt && (
              <Badge tone="success" icon={Check}>
                Called back
              </Badge>
            )}
            {call.viaFallback && <Badge icon={Voicemail}>Voicemail</Badge>}
          </div>
        </div>
      </Link>
    </li>
  );
}
