// One business: its status, the on/off switch, and its calls, newest first, filterable by
// urgency and by UK date, fifty at a time.
import {
  URGENCIES,
  type CallListView,
  type CallSummaryView,
  type MeView,
  type SwitchView,
  type TenantView,
} from "@callmate/shared";
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { asError, useApi, useLoad } from "../api.ts";
import { callsQuery, NO_FILTERS, type CallFilters } from "../calls-query.ts";
import { formatDuration, formatPhone, urgencyLabel } from "../format.ts";
import { TenantHeader } from "../tenant-header.tsx";
import { formatUkDateTime } from "../time.ts";
import { ErrorNote, UrgencyBadge } from "../ui.tsx";

export function TenantPage({ me }: { me: MeView }) {
  const { tenantId = "" } = useParams();
  const { api } = useApi();
  const tenant = useLoad(() => api<TenantView>(`/tenants/${tenantId}`), tenantId);

  if (tenant.status === "loading") return <p className="muted">Loading…</p>;
  if (tenant.status === "error") return <ErrorNote error={tenant.error} retry={tenant.reload} />;

  return (
    <>
      <TenantHeader me={me} tenant={tenant.data} />
      <AnsweringSwitch tenant={tenant.data} onChanged={tenant.reload} />
      <Calls tenantId={tenantId} />
    </>
  );
}

/** On and off are only for a live or paused business; anything else is support's job. */
function AnsweringSwitch({ tenant, onChanged }: { tenant: TenantView; onChanged: () => void }) {
  const { api } = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  if (tenant.status !== "live" && tenant.status !== "paused") return null;

  const on = tenant.status === "live";
  const flip = async () => {
    const question = on
      ? "Switch AnswerMate off? Callers will go to voicemail until you switch it back on."
      : "Switch AnswerMate back on?";
    if (!window.confirm(question)) return;
    setBusy(true);
    setError(null);
    try {
      await api<SwitchView>(`/tenants/${tenant.id}/switch`, { method: "PUT", body: { on: !on } });
      onChanged();
    } catch (caught) {
      setError(asError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card switch">
      <p>
        AnswerMate is <strong>{on ? "on" : "off"}</strong>
        {on ? " and answering calls." : ". Callers go to voicemail."}
      </p>
      <button type="button" disabled={busy} onClick={() => void flip()}>
        {on ? "Switch off" : "Switch on"}
      </button>
      {error && <ErrorNote error={error} />}
    </section>
  );
}

interface CallPages {
  calls: CallSummaryView[];
  nextBefore: string | null;
}

function Calls({ tenantId }: { tenantId: string }) {
  const { api } = useApi();
  const [filters, setFilters] = useState<CallFilters>(NO_FILTERS);
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

  return (
    <section>
      <h2>Calls</h2>
      <form className="filters" onSubmit={(event) => event.preventDefault()}>
        <label>
          Urgency
          <select
            value={filters.urgency}
            onChange={(event) => set({ urgency: event.target.value })}
          >
            <option value="">All</option>
            {URGENCIES.map((urgency) => (
              <option key={urgency} value={urgency}>
                {urgencyLabel(urgency)}
              </option>
            ))}
          </select>
        </label>
        <label>
          From
          <input
            type="date"
            value={filters.from}
            onChange={(event) => set({ from: event.target.value })}
          />
        </label>
        <label>
          To
          <input
            type="date"
            value={filters.to}
            onChange={(event) => set({ to: event.target.value })}
          />
        </label>
        {query !== "" && (
          <button type="button" className="link" onClick={() => setFilters(NO_FILTERS)}>
            Clear
          </button>
        )}
      </form>

      {error && <ErrorNote error={error} />}
      {!pages && !error && <p className="muted">Loading calls…</p>}
      {pages && pages.calls.length === 0 && <p className="muted">No calls match.</p>}
      {pages && (
        <ul className="list">
          {pages.calls.map((call) => (
            <CallRow key={call.callId} tenantId={tenantId} call={call} />
          ))}
        </ul>
      )}
      {pages?.nextBefore && (
        <button type="button" disabled={loadingMore} onClick={() => void loadMore()}>
          {loadingMore ? "Loading…" : "Show older calls"}
        </button>
      )}
    </section>
  );
}

function CallRow({ tenantId, call }: { tenantId: string; call: CallSummaryView }) {
  const caller = call.fields.callerName ?? "Unknown caller";
  const number = call.fields.callbackNumber ?? call.callerNumber;
  return (
    <li className="card">
      <Link to={`/tenants/${tenantId}/calls/${call.callId}`} className="call-link">
        <div className="row">
          <span>{formatUkDateTime(call.startedAt)}</span>
          <UrgencyBadge urgency={call.urgency} />
        </div>
        <p className="row-title">
          {caller}
          {number && <span className="muted"> · {formatPhone(number)}</span>}
          {call.viaFallback && <span className="muted"> · voicemail</span>}
        </p>
        <p className="summary">{call.summary ?? "No summary yet."}</p>
        <p className="muted">{formatDuration(call.durationSeconds)}</p>
      </Link>
    </li>
  );
}
