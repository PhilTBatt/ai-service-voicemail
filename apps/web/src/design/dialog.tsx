// Asking before doing something that matters: switching the assistant off, suspending a
// business, deleting data. Replaces the browser's own confirm() and prompt() boxes, which can't
// be styled, can't explain much, and some browsers let people silence. Built on the <dialog>
// element, so the keyboard, Escape and focus work as the browser does them.
//
//   const confirm = useConfirm();
//   if (!(await confirm({ title: "Switch AnswerMate off?", confirmLabel: "Switch off" }))) return;
//
// With `requireText`, the button stays off until that text is typed: for anything final.
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CircleAlert, Info, TriangleAlert } from "./icons.ts";
import type { Tone } from "./tone.ts";

export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** danger for anything final or that stops calls being answered; brand for the rest. */
  tone?: Extract<Tone, "danger" | "warning" | "brand">;
  /** Typed (in any case, spaces at the ends aside) before the button works: a business's name. */
  requireText?: string;
  requireLabel?: string;
}

interface Request {
  id: number;
  options: ConfirmOptions;
  resolve: (typed: string | null) => void;
  /** What had focus when it opened (the button pressed), given focus back when it closes. */
  opener: HTMLElement | null;
}

const ConfirmContext = createContext<(options: ConfirmOptions) => Promise<string | null>>(() =>
  Promise.resolve(null),
);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<Request | null>(null);
  const nextId = useRef(1);
  const open = useCallback(
    (options: ConfirmOptions) =>
      new Promise<string | null>((resolve) =>
        setRequest({
          id: nextId.current++,
          options,
          resolve,
          opener: document.activeElement instanceof HTMLElement ? document.activeElement : null,
        }),
      ),
    [],
  );
  const settle = (typed: string | null) => {
    if (!request) return;
    request.resolve(typed);
    setRequest(null);
    // Removing an open <dialog> doesn't hand focus back the way closing one does: do it here,
    // so the keyboard carries on from the button that asked.
    window.setTimeout(() => {
      if (request.opener?.isConnected) request.opener.focus();
    }, 0);
  };
  return (
    <ConfirmContext value={open}>
      {children}
      {request && <ConfirmDialog key={request.id} options={request.options} onSettle={settle} />}
    </ConfirmContext>
  );
}

/** Asks a yes-or-no question; true if they said yes. */
export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  const open = use(ConfirmContext);
  return useCallback((options) => open(options).then((typed) => typed !== null), [open]);
}

/** Asks for the `requireText` to be typed; what was typed if they went ahead, else null. */
export function useConfirmTyped(): (
  options: ConfirmOptions & { requireText: string },
) => Promise<string | null> {
  return use(ConfirmContext);
}

function ConfirmDialog({
  options,
  onSettle,
}: {
  options: ConfirmOptions;
  onSettle: (typed: string | null) => void;
}) {
  const {
    title,
    body,
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    tone = "brand",
    requireText,
    requireLabel,
  } = options;
  const ref = useRef<HTMLDialogElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const [typed, setTyped] = useState("");
  const titleId = useId();
  const inputId = useId();
  // In any case, as the API compares a typed business name.
  const ready =
    requireText === undefined || typed.trim().toLowerCase() === requireText.trim().toLowerCase();
  const Icon = tone === "danger" ? CircleAlert : tone === "warning" ? TriangleAlert : Info;
  // The safe choice has focus first for anything dangerous; otherwise the action.
  const focusAction = tone !== "danger" && requireText === undefined;

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    // showModal() puts focus on the first control: Cancel, or the box to type in, which is
    // right for anything dangerous. React's autoFocus can't override it (it focuses before
    // showModal runs), so the action is focused here, after.
    if (focusAction) confirmButton.current?.focus();
  }, [focusAction]);

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      // Escape, or the browser closing it: the same as Cancel.
      onCancel={(event) => {
        event.preventDefault();
        onSettle(null);
      }}
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) onSettle(typed);
        }}
      >
        <div className="dialog-body" data-tone={tone}>
          <div className="dialog-icon">
            <Icon size={20} />
          </div>
          <div className="dialog-content">
            <h2 id={titleId} className="dialog-title">
              {title}
            </h2>
            {body && <div className="dialog-text stack stack-sm">{body}</div>}
            {requireText !== undefined && (
              <div className="field">
                <label htmlFor={inputId} className="field-label">
                  {requireLabel ?? `Type ${requireText} to confirm`}
                </label>
                <input
                  id={inputId}
                  className="input"
                  autoComplete="off"
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                />
              </div>
            )}
          </div>
        </div>
        <div className="dialog-footer">
          <button type="button" className="btn btn-secondary" onClick={() => onSettle(null)}>
            {cancelLabel}
          </button>
          <button
            ref={confirmButton}
            type="submit"
            className={`btn ${tone === "danger" ? "btn-danger" : "btn-primary"}`}
            disabled={!ready}
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
