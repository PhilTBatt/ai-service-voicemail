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
import {
  Alert,
  Button,
  Card,
  Checkbox,
  EmptyState,
  ErrorNote,
  FieldErrors,
  Loading,
  PageHeader,
  RadioGroup,
  SelectField,
  TextField,
} from "../design/components.tsx";
import { Building, ExternalLink, FileText, Link2, Smartphone } from "../design/icons.ts";
import { humanise, toUkMobileE164 } from "../format.ts";
import { Brand } from "../shell/AppShell.tsx";
import { signupProblems, type SignupProblems } from "../signup-form.ts";

export function SignupPage() {
  const [params] = useSearchParams();
  const code = params.get("code") ?? "";
  const { api } = useApi();
  const link = useLoad(() => api<SignupLinkView>(`/signup/${encodeURIComponent(code)}`), code);

  return (
    <div className="standalone">
      <header className="standalone-header">
        <Brand />
      </header>
      <main className="content stack stack-lg">
        {link.status === "loading" && <Loading label="Checking your link…" />}
        {link.status === "error" && (
          <div className="card">
            <EmptyState
              icon={Link2}
              headingLevel={1}
              title="This link can't be used"
              action={
                // Someone tapping the old link after signing up wants their dashboard.
                <a className="btn btn-secondary" href="/">
                  Already signed up? Open your dashboard
                </a>
              }
            >
              {link.error.message}. Ask whoever sent it for a new one.
            </EmptyState>
          </div>
        )}
        {link.status === "ready" && (
          <>
            <Show when="signed-out">
              <PageHeader
                title="Set up AnswerMate for your business"
                description="First, sign in or create your login with the email address you'll use for AnswerMate. Then you'll tell us about your business."
              />
              <div className="auth-intro">
                <SignIn
                  forceRedirectUrl={window.location.href}
                  signUpForceRedirectUrl={window.location.href}
                />
              </div>
            </Show>
            <Show when="signed-in">
              <PageHeader
                title="Tell us about your business"
                description="A few details for the assistant and your texts. You can change them later."
              />
              <SignupForm code={code} link={link.data} />
            </Show>
          </>
        )}
      </main>
    </div>
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

function SignupForm({ code, link }: { code: string; link: SignupLinkView }) {
  const { api } = useApi();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [problems, setProblems] = useState<SignupProblems>({});
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
      setProblems(signupProblems(checked.success ? [] : checked.error.issues, missingVoicemail));
      return;
    }
    setProblems({});
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
      className="form-sections"
      // The schema checks it, and says what's wrong by each field. Without this, the browser's
      // own email check stopped the form first, so nothing else was checked or marked.
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Card icon={Building} title="Your business">
        <TextField
          label="Business name"
          autoComplete="organization"
          value={form.businessName}
          error={problems.businessName}
          onChange={(event) => update({ businessName: event.target.value })}
        />
        <SelectField
          label="Trade"
          value={form.trade}
          error={problems.trade}
          onChange={(event) => update({ trade: event.target.value })}
        >
          {TRADES.map((trade) => (
            <option key={trade} value={trade}>
              {humanise(trade)}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Your name"
          hint={`As callers will hear it: "Sam will call you back".`}
          autoComplete="given-name"
          value={form.contactName}
          error={problems.contactName}
          onChange={(event) => update({ contactName: event.target.value })}
        />
      </Card>

      <Card icon={Smartphone} title="Your phone">
        <TextField
          label="Mobile, for texts about each call"
          type="tel"
          autoComplete="tel"
          placeholder="07700 900123"
          value={form.mobile}
          error={problems.mobile}
          onChange={(event) => update({ mobile: event.target.value })}
        />
        <TextField
          label="Email for call details"
          hint="Leave empty to use the one you signed in with."
          type="email"
          autoComplete="email"
          value={form.email}
          error={problems.email}
          onChange={(event) => update({ email: event.target.value })}
        />
        <SelectField
          label="Mobile network"
          hint="For the instructions to send the calls you miss to AnswerMate."
          value={form.mobileNetwork}
          error={problems.mobileNetwork}
          onChange={(event) => update({ mobileNetwork: event.target.value })}
        >
          <option value="">Choose your network</option>
          {MOBILE_NETWORK_KEYS.map((network) => (
            <option key={network} value={network}>
              {MOBILE_NETWORKS[network]}
            </option>
          ))}
        </SelectField>
        <RadioGroup
          legend="Do you use your network's voicemail now?"
          name="voicemail"
          inline
          options={[
            { value: "yes", label: "Yes" },
            { value: "no", label: "No" },
          ]}
          value={form.usesNetworkVoicemail}
          onChange={(answer) => update({ usesNetworkVoicemail: answer })}
        />
        <FieldErrors messages={problems.usesNetworkVoicemail} />
      </Card>

      <Card icon={FileText} title="The small print">
        {placeholders && (
          <Alert tone="info">
            <p>
              These documents are placeholders while a solicitor writes the real ones.
              {link.forTest
                ? " This is a test signup."
                : " Until they're in place, your service can't go live."}
            </p>
          </Alert>
        )}
        {LEGAL_DOCUMENT_TYPES.map((type) => {
          const document = link.documents[type];
          return (
            <div key={type} className="stack stack-xs">
              <Checkbox
                label={`I accept the ${document.title}`}
                checked={form.accepted[type]}
                onChange={(event) =>
                  update({ accepted: { ...form.accepted, [type]: event.target.checked } })
                }
              />
              <p className="field-hint">
                Version {document.version}. {document.summary}{" "}
                {document.url && (
                  <a href={document.url} target="_blank" rel="noreferrer">
                    Read the {document.title} <ExternalLink size={12} className="inline-icon" />
                  </a>
                )}
              </p>
            </div>
          );
        })}
        <FieldErrors messages={problems.accepted} />
      </Card>

      <div className="save-bar">
        <div className="stack stack-xs">
          {Object.keys(problems).length > 0 ? (
            <FieldErrors messages={["Some details need changing. They're marked above."]} />
          ) : (
            <span className="muted text-sm">
              Your business is set up as soon as you press this.
            </span>
          )}
          {error && (
            <>
              <ErrorNote error={error} />
              {/already have an AnswerMate account/i.test(error.message) && (
                <p>
                  <a href="/">Open your dashboard</a>
                </p>
              )}
            </>
          )}
        </div>
        <Button type="submit" loading={busy}>
          Set up my business
        </Button>
      </div>
    </form>
  );
}
