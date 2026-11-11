// One call: who rang, what they wanted, the transcript and the recording. The recording needs
// the login token, which an <audio> tag can't send, so it's fetched as a file first and played
// from memory; nothing is stored in the browser.
import type { CallHandledView, CallView } from "@callmate/shared";
import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router";
import { asError, useApi, useLoad } from "../api.ts";
import { formatDuration, formatPhone } from "../format.ts";
import { formatUkDateTime } from "../time.ts";
import { ErrorNote, UrgencyBadge } from "../ui.tsx";

export function CallPage() {
  const { tenantId = "", callId = "" } = useParams();
  const { api } = useApi();
  // The list this call was opened from, filters and all, so "All calls" goes back to it.
  const listSearch = (useLocation().state as { listSearch?: string } | null)?.listSearch ?? "";
  const call = useLoad(
    () => api<CallView>(`/tenants/${tenantId}/calls/${callId}`),
    `${tenantId}/${callId}`,
  );

  if (call.status === "loading") return <p className="muted">Loading call…</p>;
  if (call.status === "error") return <ErrorNote error={call.error} retry={call.reload} />;

  const data = call.data;
  const number = data.fields.callbackNumber ?? data.callerNumber;
  return (
    <>
      <p>
        <Link to={`/tenants/${tenantId}${listSearch ? `?${listSearch}` : ""}`}>← All calls</Link>
      </p>
      <h1>{data.fields.callerName ?? "Unknown caller"}</h1>
      <p className="muted">
        {formatUkDateTime(data.startedAt)} · {formatDuration(data.durationSeconds)}
        {data.viaFallback && " · voicemail"}
      </p>
      <p>
        <UrgencyBadge urgency={data.urgency} />
        {data.flags.map((flag) => (
          <span key={flag} className="badge flag">
            {flag}
          </span>
        ))}
      </p>

      <CalledBack
        key={callId}
        tenantId={tenantId}
        callId={callId}
        initialHandledAt={data.handledAt}
      />

      <section className="card">
        <dl className="details">
          <dt>Call back on</dt>
          <dd>{number ? <a href={`tel:${number}`}>{formatPhone(number)}</a> : "Withheld"}</dd>
          <dt>Postcode</dt>
          <dd>{data.fields.postcode ?? "Not given"}</dd>
          {data.callerNumber && number !== data.callerNumber && (
            <>
              <dt>Rang from</dt>
              <dd>
                <a href={`tel:${data.callerNumber}`}>{formatPhone(data.callerNumber)}</a>
              </dd>
            </>
          )}
        </dl>
        <h2>Summary</h2>
        <p>{data.summary ?? "No summary yet."}</p>
      </section>

      {data.recording.available && <Recording tenantId={tenantId} callId={callId} />}

      <section>
        <h2>Transcript</h2>
        {data.transcript === null ? (
          <p className="muted">No transcript for this call.</p>
        ) : (
          <ol className="transcript">
            {data.transcript.map((turn, index) => (
              <li key={index} className={`turn turn-${turn.role}`}>
                <span className="speaker">{turn.role === "agent" ? "AnswerMate" : "Caller"}</span>
                {turn.text}
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}

/**
 * "Called back": ticks the call off the list of ones needing a reply, or puts it back. Keeps
 * its own state from the answer rather than reloading the call, so the page stays put and a
 * recording that's playing carries on.
 */
function CalledBack({
  tenantId,
  callId,
  initialHandledAt,
}: {
  tenantId: string;
  callId: string;
  initialHandledAt: string | null;
}) {
  const { api } = useApi();
  const [handledAt, setHandledAt] = useState(initialHandledAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const mark = async (handled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<CallHandledView>(`/tenants/${tenantId}/calls/${callId}/handled`, {
        method: "PUT",
        body: { handled },
      });
      setHandledAt(result.handledAt);
    } catch (caught) {
      setError(asError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card switch">
      {handledAt ? (
        <>
          <p>
            <span className="badge handled">Called back</span> {formatUkDateTime(handledAt)}
          </p>
          <button type="button" className="link" disabled={busy} onClick={() => void mark(false)}>
            Not done yet
          </button>
        </>
      ) : (
        <>
          <p>Needs a reply.</p>
          <button type="button" disabled={busy} onClick={() => void mark(true)}>
            Mark as called back
          </button>
        </>
      )}
      {error && <ErrorNote error={error} />}
    </section>
  );
}

function Recording({ tenantId, callId }: { tenantId: string; callId: string }) {
  const { fetchBlob } = useApi();
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Let the browser free the audio when the page closes.
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );

  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      const audio = await fetchBlob(`/tenants/${tenantId}/calls/${callId}/recording`);
      setUrl(URL.createObjectURL(audio));
    } catch (caught) {
      setError(asError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>Recording</h2>
      {url ? (
        <audio controls autoPlay src={url} />
      ) : (
        <button type="button" disabled={busy} onClick={() => void load()}>
          {busy ? "Loading…" : "Play recording"}
        </button>
      )}
      {error && <ErrorNote error={error} />}
    </section>
  );
}
