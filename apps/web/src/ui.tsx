// AnswerMate's own pieces, made from the design system's (design/components.tsx): those know
// nothing about calls or businesses; these do.
import { Badge } from "./design/components.tsx";
import { statusDisplay, urgencyLabel, urgencyTone } from "./format.ts";

export { ErrorNote } from "./design/components.tsx";

export function UrgencyBadge({ urgency }: { urgency: string | null }) {
  return (
    <Badge tone={urgencyTone(urgency)} dot>
      {urgencyLabel(urgency)}
    </Badge>
  );
}

/** A business's status in words ("Answering", "Switched off"), coloured for what it means. */
export function StatusBadge({ status }: { status: string }) {
  const { label, tone } = statusDisplay(status);
  return (
    <Badge tone={tone} dot>
      {label}
    </Badge>
  );
}

/** The AnswerMate mark: a speech bubble, answering. The favicon is the same drawing. */
export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--color-brand-solid)" />
      <path
        d="M8 11a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3h-6l-4.5 3.5V21H11a3 3 0 0 1-3-3z"
        fill="#ffffff"
      />
      <circle cx="12.5" cy="14.5" r="1.4" fill="var(--color-brand-solid)" />
      <circle cx="16" cy="14.5" r="1.4" fill="var(--color-brand-solid)" />
      <circle cx="19.5" cy="14.5" r="1.4" fill="var(--color-brand-solid)" />
    </svg>
  );
}
