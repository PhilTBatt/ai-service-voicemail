// Following a signup link (BUILD_PLAN Step 11). The link's code is in the address. First the
// person signs in, or creates a login, so their email is verified; then they tell us about the
// business and accept the documents, and the API creates the business with them as its owner.
import {
  LEGAL_DOCUMENT_TYPES,
  MOBILE_NETWORKS,
  MOBILE_NETWORK_KEYS,
  TRADES,
  signupInputSchema,
  type LegalDocumentType,
  type SignupLinkView,
  type SignupResultView,
} from "@callmate/shared";
import { Show, SignIn } from "@clerk/react";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { asError, useApi, useLoad } from "../api.ts";
import { humanise, toUkMobileE164 } from "../format.ts";
import { ErrorNote } from "../ui.tsx";

export function SignupPage() {
  const [params] = useSearchParams();
  const code = params.get("code") ?? "";
  const { api } = useApi();
  const link = useLoad(() => api<SignupLinkView>(`/signup/${encodeURIComponent(code)}`), code);

  return (
    <main className="page">
      <h1 className="brand">AnswerMate</h1>
      {link.status === "loading" && <p className="muted">Checking your link…</p>}
      {link.status === "error" && (
        <section className="card error">
          <h2>This link can't be used</h2>
          <p>{link.error.message}. Ask whoever sent it for a new one.</p>
        </section>
      )}
      {link.status === "ready" && (
        <>
          <Show when="signed-out">
            <section className="card">
              <h2>Set up AnswerMate for your business</h2>
              <p>
                First, sign in or create your login with the email address you'll use for
                AnswerMate. Then you'll tell us about your business.
              </p>
            </section>
            <div className="sign-in">
              <SignIn
                forceRedirectUrl={window.location.href}
                signUpForceRedirectUrl={window.location.href}
              />
            </div>
          </Show>
          <Show when="signed-in">
            <SignupForm code={code} link={link.data} />
          </Show>
        </>
      )}
    </main>
  );
}

interface FormState {
  businessName: string;
  trade: string;
  contactName: string;
  mobile: string;
  email: string;
  mobileNetwork: string;
  usesNetworkVoicemail: "" | "yes" | "no";
  accepted: Record<LegalDocumentType, boolean>;
}

const EMPTY: FormState = {
  businessName: "",
  trade: "plumber",
  contactName: "",
  mobile: "",
  email: "",
  mobileNetwork: "",
  usesNetworkVoicemail: "",
  accepted: { terms: false, dpa: false, privacy_notice: false },
};

const FIELD_LABELS: Record<string, string> = {
  businessName: "Business name",
  trade: "Trade",
  contactName: "Your name",
  mobile: "Mobile",
  email: "Email",
  mobileNetwork: "Mobile network",
  usesNetworkVoicemail: "Voicemail",
  accepted: "Documents",
};

function SignupForm({ code, link }: { code: string; link: SignupLinkView }) {
  const { api } = useApi();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const update = (change: Partial<FormState>) => setForm((current) => ({ ...current, ...change }));
  const placeholders = LEGAL_DOCUMENT_TYPES.some((type) => !link.documents[type].approved);

  const submit = async () => {
    const candidate = {
      code,
      businessName: form.businessName,
      trade: form.trade,
      contactName: form.contactName,
      mobile: toUkMobileE164(form.mobile),
      email: form.email.trim() === "" ? null : form.email.trim(),
      mobileNetwork: form.mobileNetwork,
      usesNetworkVoicemail: form.usesNetworkVoicemail === "yes",
      // The version each ticked document was shown at; an unticked one sends nothing.
      accepted: Object.fromEntries(
        LEGAL_DOCUMENT_TYPES.map((type) => [
          type,
          form.accepted[type] ? link.documents[type].version : "",
        ]),
      ),
    };
    const checked = signupInputSchema.safeParse(candidate);
    const missingVoicemail = form.usesNetworkVoicemail === "";
    if (!checked.success || missingVoicemail) {
      const messages = checked.success
        ? []
        : checked.error.issues.map((issue) => {
            const field = String(issue.path[0]);
            return field === "accepted"
              ? "Documents: tick all three to continue"
              : `${FIELD_LABELS[field] ?? field}: ${issue.message}`;
          });
      if (missingVoicemail) messages.push("Voicemail: choose yes or no");
      setProblems([...new Set(messages)]);
      return;
    }
    setProblems([]);
    setBusy(true);
    setError(null);
    try {
      await api<SignupResultView>("/signup", { method: "POST", body: checked.data });
      // Reload from the top: they're the owner now, and the dashboard takes them to the business.
      window.location.assign("/");
    } catch (caught) {
      setError(asError(caught));
      setBusy(false);
    }
  };

  return (
    <form
      className="profile"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <section className="card">
        <h2>Your business</h2>
        <label className="stacked">
          Business name
          <input
            value={form.businessName}
            onChange={(event) => update({ businessName: event.target.value })}
          />
        </label>
        <label className="stacked">
          Trade
          <select value={form.trade} onChange={(event) => update({ trade: event.target.value })}>
            {TRADES.map((trade) => (
              <option key={trade} value={trade}>
                {humanise(trade)}
              </option>
            ))}
          </select>
        </label>
        <label className="stacked">
          Your name, as callers will hear it ("Sam will call you back")
          <input
            value={form.contactName}
            onChange={(event) => update({ contactName: event.target.value })}
          />
        </label>
      </section>

      <section className="card">
        <h2>Your phone</h2>
        <label className="stacked">
          Mobile, for texts about each call
          <input
            type="tel"
            autoComplete="tel"
            placeholder="07700 900123"
            value={form.mobile}
            onChange={(event) => update({ mobile: event.target.value })}
          />
        </label>
        <label className="stacked">
          Email for call details (leave empty to use the one you signed in with)
          <input
            type="email"
            value={form.email}
            onChange={(event) => update({ email: event.target.value })}
          />
        </label>
        <label className="stacked">
          Mobile network (for the instructions to send missed calls to AnswerMate)
          <select
            value={form.mobileNetwork}
            onChange={(event) => update({ mobileNetwork: event.target.value })}
          >
            <option value="">Choose your network</option>
            {MOBILE_NETWORK_KEYS.map((network) => (
              <option key={network} value={network}>
                {MOBILE_NETWORKS[network]}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="stacked">
          <legend>Do you use your network's voicemail now?</legend>
          {(["yes", "no"] as const).map((answer) => (
            <label key={answer} className="check">
              <input
                type="radio"
                name="voicemail"
                checked={form.usesNetworkVoicemail === answer}
                onChange={() => update({ usesNetworkVoicemail: answer })}
              />
              {answer === "yes" ? "Yes" : "No"}
            </label>
          ))}
        </fieldset>
      </section>

      <section className="card">
        <h2>The small print</h2>
        {placeholders && (
          <p className="notice card">
            These documents are placeholders while a solicitor writes the real ones.
            {link.forTest
              ? " This is a test signup."
              : " Until they're in place, your service can't go live."}
          </p>
        )}
        {LEGAL_DOCUMENT_TYPES.map((type) => {
          const document = link.documents[type];
          return (
            <div key={type} className="document">
              <label className="check">
                <input
                  type="checkbox"
                  checked={form.accepted[type]}
                  onChange={(event) =>
                    update({ accepted: { ...form.accepted, [type]: event.target.checked } })
                  }
                />
                I accept the {document.title}
              </label>
              <p className="hint">
                Version {document.version}. {document.summary}
              </p>
            </div>
          );
        })}
      </section>

      <div className="save-bar">
        {problems.length > 0 && (
          <ul className="field-errors">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}
        {error && <ErrorNote error={error} />}
        <button type="submit" disabled={busy}>
          {busy ? "Setting up…" : "Set up my business"}
        </button>
      </div>
    </form>
  );
}
