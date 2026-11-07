// Making a signup link for a new business, on the business list (BUILD_PLAN Step 11): Phil
// and Ant can make one; only Phil can mark it as a test business. The code is shown once.
import type { CreatedSignupLinkView, MeView } from "@callmate/shared";
import { useState } from "react";
import { asError, useApi } from "./api.ts";
import { formatUkDateTime } from "./time.ts";
import { ErrorNote } from "./ui.tsx";

export function SignupLinkPanel({ me }: { me: MeView }) {
  const { api } = useApi();
  const [forTest, setForTest] = useState(false);
  const [made, setMade] = useState<CreatedSignupLinkView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [copied, setCopied] = useState(false);

  if (me.role !== "admin" && me.role !== "reseller") return null;
  const url = made ? `${window.location.origin}/signup?code=${made.code}` : "";

  const make = async () => {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      setMade(
        await api<CreatedSignupLinkView>("/signup-links", { method: "POST", body: { forTest } }),
      );
    } catch (caught) {
      setError(asError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>Sign up a new business</h2>
      <p className="hint">
        Make a link and send it to the tradesperson. It works once, for 14 days.
      </p>
      {me.role === "admin" && (
        <label className="check">
          <input
            type="checkbox"
            checked={forTest}
            onChange={(event) => setForTest(event.target.checked)}
          />
          Test business (can go live while the legal documents are placeholders)
        </label>
      )}
      <div className="save-bar">
        <button type="button" className="secondary" disabled={busy} onClick={() => void make()}>
          Create a signup link
        </button>
      </div>
      {made && (
        <div className="card notice">
          <p>
            <strong>Signup link{made.forTest ? " (test business)" : ""}</strong>. It works until{" "}
            {formatUkDateTime(made.expiresAt)}.
          </p>
          <p>
            <code className="signup-url">{url}</code>
          </p>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              void navigator.clipboard.writeText(url).then(() => setCopied(true));
            }}
          >
            {copied ? "Copied" : "Copy link"}
          </button>
          <p className="hint">
            This is the only time it's shown: only a fingerprint of it is stored.
          </p>
        </div>
      )}
      {error && <ErrorNote error={error} />}
    </section>
  );
}
