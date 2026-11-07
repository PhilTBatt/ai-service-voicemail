// One call: who rang, what they wanted, the transcript and the recording. The recording needs
// the login token, which an <audio> tag can't send, so it's fetched as a file first and played
// from memory; nothing is stored in the browser.
import type { CallView } from "@callmate/shared";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { asError, useApi, useLoad } from "../api.ts";
import { formatDuration, formatPhone } from "../format.ts";
import { formatUkDateTime } from "../time.ts";
import { ErrorNote, UrgencyBadge } from "../ui.tsx";

export function CallPage() {
  const { tenantId = "", callId = "" } = useParams();
  const { api } = useApi();
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
        <Link to={`/tenants/${tenantId}`}>← All calls</Link>
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

      <section className="card">
        <dl className="details">
          <dt>Call back on</dt>
          <dd>{number ? <a href={`tel:${number}`}>{formatPhone(number)}</a> : "Withheld"}</dd>
          <dt>Postcode</dt>
          <dd>{data.fields.postcode ?? "Not given"}</dd>
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
