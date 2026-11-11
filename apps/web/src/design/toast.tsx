// Toasts: a short message in the corner that something happened ("Copied", "Saved"), gone by
// itself after a few seconds. For news, never for a question or an error that needs reading:
// those stay on the page (Alert). Screen readers hear each one (aria-live).
import { createContext, use, useCallback, useRef, useState, type ReactNode } from "react";
import { CircleAlert, CircleCheck, Info, X } from "./icons.ts";
import type { Tone } from "./tone.ts";

export interface ToastInput {
  tone?: Extract<Tone, "success" | "info" | "danger"> | undefined;
  title: string;
  body?: string | undefined;
}

interface ShownToast extends Required<Pick<ToastInput, "tone" | "title">> {
  id: number;
  body?: string | undefined;
}

const ToastContext = createContext<(toast: ToastInput) => void>(() => undefined);

const SHOW_FOR_MS = 5_000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ShownToast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((shown) => shown.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback(
    ({ tone = "success", title, body }: ToastInput) => {
      const id = nextId.current++;
      // At most three at once: the oldest goes first.
      setToasts((shown) => [...shown.slice(-2), { id, tone, title, body }]);
      window.setTimeout(() => dismiss(id), SHOW_FOR_MS);
    },
    [dismiss],
  );

  return (
    <ToastContext value={show}>
      {children}
      <div className="toasts" aria-live="polite" aria-relevant="additions">
        {toasts.map((toast) => {
          const Icon =
            toast.tone === "danger" ? CircleAlert : toast.tone === "info" ? Info : CircleCheck;
          return (
            <div key={toast.id} className="toast" data-tone={toast.tone}>
              <Icon className="toast-icon" size={18} />
              <div className="toast-text">
                <strong>{toast.title}</strong>
                {toast.body && <p className="muted">{toast.body}</p>}
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-icon btn-sm"
                aria-label="Dismiss"
                onClick={() => dismiss(toast.id)}
              >
                <X size={16} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext>
  );
}

/** Shows a toast: `toast({ title: "Copied" })`. */
export function useToast(): (toast: ToastInput) => void {
  return use(ToastContext);
}
