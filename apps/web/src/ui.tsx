// Small pieces several pages share.
import { urgencyLabel } from "./format.ts";

export function ErrorNote({ error, retry }: { error: Error; retry?: () => void }) {
  return (
    <section className="card error" role="alert">
      <p>Something went wrong: {error.message}</p>
      {retry && (
        <button type="button" onClick={retry}>
          Try again
        </button>
      )}
    </section>
  );
}

export function UrgencyBadge({ urgency }: { urgency: string | null }) {
  return <span className={`badge urgency-${urgency ?? "none"}`}>{urgencyLabel(urgency)}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge status-${status}`}>{status}</span>;
}
