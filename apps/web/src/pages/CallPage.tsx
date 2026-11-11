// One call: who rang, a button to ring them back, whether they have been, what they wanted,
// the transcript and the recording. The recording needs the login token, which an <audio> tag
// can't send, so it's fetched as a file first and played from memory; nothing is stored in the
// browser.
import type { CallHandledView, CallView } from "@callmate/shared";
import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router";
import { asError, useApi, useLoad } from "../api.ts";
import {
  Alert,
  Avatar,
  Badge,
  Button,
  ButtonAnchor,
  Card,
  DescriptionList,
  ErrorNote,
  Loading,
} from "../design/components.tsx";
import {
  ArrowLeft,
  Check,
  FileText,
  MessageSquare,
  Phone,
  Play,
  UserRound,
  Voicemail,
} from "../design/icons.ts";
import { useToast } from "../design/toast.tsx";
import { formatDurationWords, formatPhone, urgencyTone } from "../format.ts";
import { useTenant } from "../tenant-layout.tsx";
import { formatUkDateTime } from "../time.ts";
import { UrgencyBadge } from "../ui.tsx";

export function CallPage() {
  const { tenant } = useTenant();
  const { callId = "" } = useParams();
  const tenantId = tenant.id;
  const { api } = useApi();
  // The list this call was opened from, filters and all, so "All calls" goes back to it.
  const listSearch = (useLocation().state as { listSearch?: string } | null)?.listSearch ?? "";
  const call = useLoad(
    () => api<CallView>(`/tenants/${tenantId}/calls/${callId}`),
    `${tenantId}/${callId}`,
  );
  const back = (
    <Link to={`/tenants/${tenantId}${listSearch ? `?${listSearch}` : ""}`} className="back-link">
      <ArrowLeft size={16} />
      All calls · {tenant.businessName}
    </Link>
  );

  if (call.status === "loading") {
    return (
      <div className="stack stack-lg">
        {back}
        <Loading label="Loading call…" lines={5} />
      </div>
    );
  }
  if (call.status === "error") return <ErrorNote error={call.error} retry={call.reload} />;

  const data = call.data;
  const number = data.fields.callbackNumber ?? data.callerNumber;
  return (
    <div className="stack stack-lg">
      {back}
      <header className="stack">
        <div className="call-hero">
          <Avatar name={data.fields.callerName} tone={urgencyTone(data.urgency)} size="lg" />
          <div className="stack stack-xs">
            <h1 className="page-title">{data.fields.callerName ?? "Unknown caller"}</h1>
            <p className="muted text-sm">
              {formatUkDateTime(data.startedAt)} · {formatDurationWords(data.durationSeconds)}
            </p>
          </div>
        </div>
        <div className="cluster">
          <UrgencyBadge urgency={data.urgency} />
          {data.viaFallback && <Badge icon={Voicemail}>Voicemail</Badge>}
          {data.flags.map((flag) => (
            <Badge key={flag} tone="danger">
              {flag}
            </Badge>
          ))}
        </div>
      </header>

      <div className="cluster cluster-lg">
        {number ? (
          <ButtonAnchor href={`tel:${number}`} icon={Phone} size="lg">
            Call back {formatPhone(number)}
          </ButtonAnchor>
        ) : (
          <Alert tone="neutral">
            <p>Their number was withheld.</p>
          </Alert>
        )}
        <CalledBack
          key={callId}
          tenantId={tenantId}
          callId={callId}
          initialHandledAt={data.handledAt}
        />
      </div>

      <div className="split">
        <div className="stack stack-lg">
          <Card icon={FileText} title="Summary">
            <p className="pre-line">
              {data.summary ??
                (data.viaFallback ? "A voicemail: listen to it on this page." : "No summary yet.")}
            </p>
          </Card>
          <Card icon={MessageSquare} title="Transcript">
            {data.transcript === null || data.transcript.length === 0 ? (
              <p className="muted">No transcript for this call.</p>
            ) : (
              <ol className="transcript">
                {data.transcript.map((turn, index) => (
                  <li
                    key={index}
                    className={`bubble ${turn.role === "caller" ? "bubble-caller" : ""}`}
                  >
                    <span className="bubble-speaker">
                      {turn.role === "agent" ? "AnswerMate" : "Caller"}
                    </span>
                    {turn.text}
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>
        <div className="stack stack-lg">
          <Card icon={UserRound} title="Details">
            <DescriptionList
              items={[
                { term: "Name", detail: data.fields.callerName ?? "Not given" },
                {
                  term: "Call back on",
                  detail: number ? formatPhone(number) : "Withheld",
                },
                // The caller ID too, when the caller gave another number: a misheard digit in
                // that one still leaves a number that works.
                data.callerNumber && number !== data.callerNumber
                  ? {
                      term: "Rang from",
                      detail: (
                        <a href={`tel:${data.callerNumber}`}>{formatPhone(data.callerNumber)}</a>
                      ),
                    }
                  : null,
                { term: "Postcode", detail: data.fields.postcode ?? "Not given" },
              ]}
            />
          </Card>
          {data.recording.available && <Recording tenantId={tenantId} callId={callId} />}
        </div>
      </div>
    </div>
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
  const toast = useToast();
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
      toast({ title: handled ? "Marked as called back" : "Back on the list to reply to" });
    } catch (caught) {
      setError(asError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cluster">
      {handledAt ? (
        <>
          <Badge tone="success" icon={Check}>
            Called back {formatUkDateTime(handledAt)}
          </Badge>
          <Button variant="link" disabled={busy} onClick={() => void mark(false)}>
            Not done yet
          </Button>
        </>
      ) : (
        <Button
          variant="secondary"
          size="lg"
          icon={Check}
          loading={busy}
          onClick={() => void mark(true)}
        >
          Mark as called back
        </Button>
      )}
      {error && <ErrorNote error={error} />}
    </div>
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
    <Card icon={Play} title="Recording">
      {url ? (
        <audio controls autoPlay src={url} />
      ) : (
        <Button variant="secondary" icon={Play} loading={busy} block onClick={() => void load()}>
          Play recording
        </Button>
      )}
      {error && <ErrorNote error={error} />}
    </Card>
  );
}
