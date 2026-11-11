// The dashboard's building blocks. Pages are made of these and the layout helpers in base.css
// (stack, cluster, grid, split); a page that wants something these don't do gets a new
// component here, with a name and a style in components.css, rather than one-off styling.
// docs/UI.md lists them, with when to use each.
import {
  Children,
  Fragment,
  useId,
  useRef,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { Link, useLocation, type LinkProps } from "react-router";
import { initialsOf } from "../format.ts";
import {
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Copy,
  Info,
  TriangleAlert,
  type LucideIcon,
} from "./icons.ts";
import { useToast } from "./toast.tsx";
import type { Tone } from "./tone.ts";

export type { Tone } from "./tone.ts";

const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");

/* ---------- Buttons ---------- */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "link";
export type ButtonSize = "sm" | "md" | "lg";

interface ButtonLook {
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  icon?: LucideIcon | undefined;
  block?: boolean | undefined;
  /** An icon and no words: give it an aria-label. */
  iconOnly?: boolean | undefined;
}

function buttonClass(
  { variant = "primary", size = "md", block, iconOnly }: ButtonLook,
  extra?: string,
) {
  return cx(
    "btn",
    `btn-${variant}`,
    size !== "md" && `btn-${size}`,
    block && "btn-block",
    iconOnly && "btn-icon",
    extra,
  );
}

const iconSize = (size: ButtonSize = "md") => (size === "sm" ? 16 : 18);

/**
 * A button. `loading` shows a spinner and stops a second press; the words stay, so the button
 * keeps its size and its name.
 */
export function Button({
  variant,
  size,
  icon: Icon,
  block,
  iconOnly,
  loading = false,
  type = "button",
  className,
  disabled,
  children,
  ...rest
}: ButtonLook & ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) {
  return (
    <button
      type={type}
      className={buttonClass({ variant, size, block, iconOnly }, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <span className="spinner" aria-hidden="true" />
      ) : (
        Icon && <Icon size={iconSize(size)} />
      )}
      {children}
    </button>
  );
}

/** A link inside the dashboard that looks like a button. */
export function ButtonLink({
  variant,
  size,
  icon: Icon,
  block,
  iconOnly,
  className,
  children,
  ...rest
}: ButtonLook & LinkProps) {
  return (
    <Link className={buttonClass({ variant, size, block, iconOnly }, className)} {...rest}>
      {Icon && <Icon size={iconSize(size)} />}
      {children}
    </Link>
  );
}

/** A plain link that looks like a button: a phone number (tel:), or a page elsewhere. */
export function ButtonAnchor({
  variant,
  size,
  icon: Icon,
  block,
  iconOnly,
  className,
  children,
  ...rest
}: ButtonLook & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a className={buttonClass({ variant, size, block, iconOnly }, className)} {...rest}>
      {Icon && <Icon size={iconSize(size)} />}
      {children}
    </a>
  );
}

/* ---------- Card ---------- */

/**
 * A panel of related things with an optional title, icon, actions (top right) and footer
 * (buttons along the bottom). Its children are stacked with even spacing. `flush` drops the
 * padding, for a list or table that runs edge to edge.
 */
export function Card({
  title,
  description,
  icon: Icon,
  actions,
  footer,
  tone,
  flush = false,
  headingLevel = 2,
  id,
  className,
  children,
}: {
  title?: ReactNode | undefined;
  description?: ReactNode | undefined;
  icon?: LucideIcon | undefined;
  actions?: ReactNode | undefined;
  footer?: ReactNode | undefined;
  tone?: Tone | undefined;
  flush?: boolean | undefined;
  headingLevel?: 2 | 3 | undefined;
  id?: string | undefined;
  className?: string | undefined;
  children?: ReactNode | undefined;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <section id={id} className={cx("card", flush && "card-flush", className)} data-tone={tone}>
      {(title || actions) && (
        <div className="card-header">
          <div className="card-heading">
            {Icon && (
              <span className="card-heading-icon" data-tone={tone ?? "brand"}>
                <Icon size={18} />
              </span>
            )}
            <div>
              {title && <Heading className="card-title">{title}</Heading>}
              {description && <p className="card-description">{description}</p>}
            </div>
          </div>
          {actions && <div className="cluster">{actions}</div>}
        </div>
      )}
      {Children.toArray(children).length > 0 && (
        <div className={cx("card-body", !flush && "stack")}>{children}</div>
      )}
      {footer && <div className="card-footer">{footer}</div>}
    </section>
  );
}

/* ---------- Badge, alert ---------- */

export function Badge({
  tone = "neutral",
  icon: Icon,
  dot = false,
  children,
}: {
  tone?: Tone | undefined;
  icon?: LucideIcon | undefined;
  dot?: boolean | undefined;
  children: ReactNode;
}) {
  return (
    <span className="badge" data-tone={tone}>
      {dot && <span className="badge-dot" aria-hidden="true" />}
      {Icon && <Icon size={12} strokeWidth={2.5} />}
      {children}
    </span>
  );
}

const ALERT_ICONS: Record<Tone, LucideIcon> = {
  danger: CircleAlert,
  warning: TriangleAlert,
  success: CircleCheck,
  info: Info,
  brand: Info,
  neutral: Info,
};

/**
 * Something the person should read: a problem, a warning, a confirmation. Danger alerts are
 * announced by screen readers as they appear (role="alert"); the rest aren't.
 */
export function Alert({
  tone = "info",
  title,
  icon,
  actions,
  children,
}: {
  tone?: Tone | undefined;
  title?: ReactNode | undefined;
  icon?: LucideIcon | undefined;
  actions?: ReactNode | undefined;
  children?: ReactNode | undefined;
}) {
  const Icon = icon ?? ALERT_ICONS[tone];
  return (
    <div className="alert" data-tone={tone} role={tone === "danger" ? "alert" : undefined}>
      <Icon className="alert-icon" size={18} />
      <div className="alert-content">
        {title && <p className="alert-title">{title}</p>}
        {children}
        {actions && <div className="cluster">{actions}</div>}
      </div>
    </div>
  );
}

/** An error from the API, in words, with a way to try again when there is one. */
export function ErrorNote({ error, retry }: { error: Error; retry?: () => void }) {
  return (
    <Alert
      tone="danger"
      title="Something went wrong"
      actions={
        retry && (
          <Button variant="secondary" size="sm" onClick={retry}>
            Try again
          </Button>
        )
      }
    >
      <p>{error.message}</p>
    </Alert>
  );
}

/* ---------- Page structure ---------- */

/** The top of a page: its one h1, a line under it, and the page's main actions. */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: ReactNode | undefined;
  title: ReactNode;
  description?: ReactNode | undefined;
  actions?: ReactNode | undefined;
}) {
  return (
    <header className="page-header">
      <div className="page-header-text">
        {eyebrow && <p className="page-eyebrow">{eyebrow}</p>}
        <h1 className="page-title">{title}</h1>
        {description && <p className="page-description">{description}</p>}
      </div>
      {actions && <div className="cluster">{actions}</div>}
    </header>
  );
}

/** A heading over part of a page, with actions to its right. */
export function SectionHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode | undefined;
  actions?: ReactNode | undefined;
}) {
  return (
    <div className="page-header">
      <div className="page-header-text">
        <h2 className="section-title">{title}</h2>
        {description && <p className="muted text-sm">{description}</p>}
      </div>
      {actions && <div className="cluster">{actions}</div>}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  headingLevel,
  children,
  action,
}: {
  icon: LucideIcon;
  title: ReactNode;
  /** When the empty state is the whole page, its title is the page's heading. */
  headingLevel?: 1 | 2 | 3 | undefined;
  children?: ReactNode | undefined;
  action?: ReactNode | undefined;
}) {
  const Title = headingLevel ? (`h${headingLevel}` as const) : "p";
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon size={22} />
      </span>
      <Title className="empty-title">{title}</Title>
      {children && <div className="empty-text">{children}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

/** Grey bars where something is about to appear, and the words for screen readers. */
export function Loading({ label = "Loadingâ€¦", lines = 3 }: { label?: string; lines?: number }) {
  return (
    <div className="stack stack-sm" aria-busy="true">
      <span className="sr-only" role="status">
        {label}
      </span>
      {Array.from({ length: lines }, (_, index) => (
        <div
          key={index}
          className="skeleton"
          style={{ height: index === 0 ? "1.75rem" : "1rem", width: `${90 - index * 15}%` }}
        />
      ))}
    </div>
  );
}

/* ---------- Data ---------- */

export function Avatar({
  name,
  tone = "neutral",
  size = "md",
  square = false,
}: {
  name: string | null | undefined;
  tone?: Tone | undefined;
  size?: "md" | "lg" | undefined;
  square?: boolean | undefined;
}) {
  return (
    <span
      className={cx("avatar", size === "lg" && "avatar-lg", square && "avatar-square")}
      data-tone={tone}
      aria-hidden="true"
    >
      {initialsOf(name)}
    </span>
  );
}

/** A number that matters, with what it is. */
export function Stat({
  label,
  value,
  tone,
  icon: Icon,
  hint,
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: Tone | undefined;
  icon?: LucideIcon | undefined;
  hint?: ReactNode | undefined;
}) {
  return (
    <div className="card stat" data-tone={tone}>
      <span className="stat-label">
        {Icon && <Icon size={16} />}
        {label}
      </span>
      <span className="stat-value">{value}</span>
      {hint && <span className="stat-hint">{hint}</span>}
    </div>
  );
}

/** How much of something is used: minutes of the month, say. Over the limit shows amber. */
export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const percent = max <= 0 ? 0 : Math.min(100, Math.round((value / max) * 100));
  return (
    <div
      className="meter"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      data-tone={value > max ? "warning" : "brand"}
    >
      <div className="meter-fill" style={{ width: `${percent}%` }} />
    </div>
  );
}

/** Label-value pairs: a call's details, a plan's terms. Pairs with no value are left out. */
export function DescriptionList({
  items,
}: {
  items: ({ term: ReactNode; detail: ReactNode } | false | null | undefined)[];
}) {
  return (
    <dl className="dl">
      {items.filter(Boolean).map((item, index) =>
        item ? (
          <Fragment key={index}>
            <dt>{item.term}</dt>
            <dd>{item.detail}</dd>
          </Fragment>
        ) : null,
      )}
    </dl>
  );
}

/** A code to dial or type, with a button that copies it. */
export function CopyCode({ code }: { code: string }) {
  const toast = useToast();
  return (
    <span className="copyable">
      <code className="code">{code}</code>
      <button
        type="button"
        className="btn btn-ghost btn-icon btn-sm"
        aria-label={`Copy ${code}`}
        onClick={() => {
          void navigator.clipboard
            .writeText(code)
            .then(() => toast({ title: "Copied", body: code }))
            .catch(() => toast({ tone: "danger", title: "Couldn't copy that" }));
        }}
      >
        <Copy size={14} />
      </button>
    </span>
  );
}

/* ---------- Form fields ---------- */
// Each field is a label, an optional hint under it, the control, and its errors. The label
// is the control's name (what a screen reader says, and what the browser tests find it by).

type Errors = string | string[] | undefined;

function errorList(error: Errors): string[] {
  return error === undefined ? [] : Array.isArray(error) ? error : [error];
}

function useFieldIds(hint: ReactNode, error: Errors) {
  const id = useId();
  const errors = errorList(error);
  const describedBy = cx(hint !== undefined && `${id}-hint`, errors.length > 0 && `${id}-error`);
  return {
    id,
    errors,
    control: {
      id,
      "aria-invalid": errors.length > 0 || undefined,
      "aria-describedby": describedBy || undefined,
    },
  };
}

function FieldParts({
  id,
  label,
  hideLabel,
  hint,
  errors,
  children,
}: {
  id: string;
  label: ReactNode;
  hideLabel?: boolean | undefined;
  hint: ReactNode;
  errors: string[];
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={id} className={hideLabel ? "sr-only" : "field-label"}>
        {label}
      </label>
      {hint !== undefined && (
        <p id={`${id}-hint`} className="field-hint">
          {hint}
        </p>
      )}
      {children}
      <FieldErrors id={`${id}-error`} messages={errors} />
    </div>
  );
}

/** Problems with what was typed, in red, each on its own line. */
export function FieldErrors({ id, messages }: { id?: string; messages: string[] | undefined }) {
  if (!messages || messages.length === 0) return null;
  return (
    <ul id={id} className="field-errors">
      {messages.map((message) => (
        <li key={message} className="field-error">
          <CircleAlert size={14} />
          <span>{message}</span>
        </li>
      ))}
    </ul>
  );
}

interface FieldProps {
  label: ReactNode;
  /** The label is said to screen readers but not shown (a card's title already says it). */
  hideLabel?: boolean | undefined;
  hint?: ReactNode | undefined;
  error?: Errors | undefined;
}

export function TextField({
  label,
  hideLabel,
  hint,
  error,
  className,
  ...input
}: FieldProps & InputHTMLAttributes<HTMLInputElement>) {
  const { id, errors, control } = useFieldIds(hint, error);
  return (
    <FieldParts id={id} label={label} hideLabel={hideLabel} hint={hint} errors={errors}>
      <input className={cx("input", className)} {...control} {...input} />
    </FieldParts>
  );
}

export function TextAreaField({
  label,
  hideLabel,
  hint,
  error,
  className,
  ...textarea
}: FieldProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { id, errors, control } = useFieldIds(hint, error);
  return (
    <FieldParts id={id} label={label} hideLabel={hideLabel} hint={hint} errors={errors}>
      <textarea className={cx("textarea", className)} {...control} {...textarea} />
    </FieldParts>
  );
}

export function SelectField({
  label,
  hideLabel,
  hint,
  error,
  className,
  children,
  ...select
}: FieldProps & SelectHTMLAttributes<HTMLSelectElement>) {
  const { id, errors, control } = useFieldIds(hint, error);
  return (
    <FieldParts id={id} label={label} hideLabel={hideLabel} hint={hint} errors={errors}>
      <span className={cx("select-wrap", className)}>
        <select className="select" {...control} {...select}>
          {children}
        </select>
        <ChevronDown size={18} />
      </span>
    </FieldParts>
  );
}

/** A tick box with its words beside it, and an optional line under them. */
export function Checkbox({
  label,
  description,
  ...input
}: { label: ReactNode; description?: ReactNode } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="choice">
      <input type="checkbox" {...input} />
      <span className="choice-text">
        <span className="choice-label">{label}</span>
        {description && <span className="field-hint">{description}</span>}
      </span>
    </label>
  );
}

/** An on/off setting: a tick box drawn as a switch, read out as one. */
export function Switch({
  label,
  description,
  ...input
}: { label: ReactNode; description?: ReactNode } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="choice">
      <input type="checkbox" role="switch" className="switch-input" {...input} />
      <span className="choice-text">
        <span className="choice-label">{label}</span>
        {description && <span className="field-hint">{description}</span>}
      </span>
    </label>
  );
}

/** One choice of a few, as radio buttons under a question. */
export function RadioGroup<T extends string>({
  legend,
  name,
  options,
  value,
  onChange,
  inline = false,
}: {
  legend: ReactNode;
  name: string;
  options: readonly { value: T; label: ReactNode; description?: ReactNode }[];
  value: T | "";
  onChange: (value: T) => void;
  inline?: boolean | undefined;
}) {
  return (
    <fieldset className="choices">
      <legend>{legend}</legend>
      <div className={cx("choices", inline && "choices-inline")}>
        {options.map((option) => (
          <label key={option.value} className="choice">
            <input
              type="radio"
              name={name}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            <span className="choice-text">
              <span className="choice-label">{option.label}</span>
              {option.description && <span className="field-hint">{option.description}</span>}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * A row of options, exactly one chosen: a filter, say. A radio group to screen readers; the
 * arrow keys move between options, as they do in one.
 */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (event: KeyboardEvent, index: number) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (index + step + options.length) % options.length;
    refs.current[next]?.focus();
    onChange(options[next]!.value);
  };
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option, index) => (
        <button
          key={option.value}
          ref={(element) => {
            refs.current[index] = element;
          }}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={option.value === value ? 0 : -1}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => move(event, index)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Links across the top of a section's pages (the Admin pages). The page on screen is marked
 * for screen readers (aria-current) as well as underlined. On a phone the row scrolls sideways.
 */
export function Tabs({
  label,
  items,
}: {
  label: string;
  items: readonly { to: string; label: string; exact?: boolean | undefined }[];
}) {
  const { pathname } = useLocation();
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return (
    <nav className="tabs" aria-label={label}>
      {items.map((item) => {
        const current = item.exact
          ? path === item.to
          : path === item.to || path.startsWith(`${item.to}/`);
        return (
          <Link
            key={item.to}
            to={item.to}
            className="tab"
            aria-current={current ? "page" : undefined}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** A filter that's on or off: "Needs a reply". */
export function ToggleChip({
  pressed,
  onChange,
  icon: Icon,
  children,
}: {
  pressed: boolean;
  onChange: (pressed: boolean) => void;
  icon?: LucideIcon | undefined;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="chip"
      aria-pressed={pressed}
      onClick={() => onChange(!pressed)}
    >
      {pressed ? <Check size={14} strokeWidth={3} /> : Icon && <Icon size={14} />}
      {children}
    </button>
  );
}
