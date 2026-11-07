// What the assistant knows about one business: trade, services, areas, hours, holidays,
// urgent call-outs and the questions callers ask. Saving makes a new version; the worker sends
// it to the voice platform, and this page shows when the assistant is using it.
import {
  agentProfileInputSchema,
  PROFILE_LIMITS,
  TRADES,
  WEEKDAYS,
  type MeView,
  type ProfileView,
  type SaveProfileView,
  type SyncView,
  type TenantView,
  type Weekday,
} from "@callmate/shared";
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { asError, useApi, useLoad } from "../api.ts";
import { humanise } from "../format.ts";
import {
  blankForm,
  DAY_NAMES,
  formErrors,
  formToProfile,
  profileToForm,
  type DayForm,
  type FaqForm,
  type FormErrors,
  type ProfileForm,
} from "../profile-form.ts";
import { TenantHeader } from "../tenant-header.tsx";
import { formatUkDateTime } from "../time.ts";
import { ErrorNote } from "../ui.tsx";

export function ProfilePage({ me }: { me: MeView }) {
  const { tenantId = "" } = useParams();
  const { api } = useApi();
  const loaded = useLoad(async () => {
    const [tenant, saved] = await Promise.all([
      api<TenantView>(`/tenants/${tenantId}`),
      api<ProfileView>(`/tenants/${tenantId}/profile`),
    ]);
    return { tenant, saved };
  }, tenantId);

  if (loaded.status === "loading") return <p className="muted">Loading…</p>;
  if (loaded.status === "error") return <ErrorNote error={loaded.error} retry={loaded.reload} />;

  const { tenant, saved } = loaded.data;
  return (
    <>
      <TenantHeader me={me} tenant={tenant} />
      <ProfileEditor key={tenant.id} tenant={tenant} saved={saved} isAdmin={me.role === "admin"} />
    </>
  );
}

const POLL_EVERY_MS = 5_000;
const POLL_TRIES = 24; // two minutes

function ProfileEditor({
  tenant,
  saved,
  isAdmin,
}: {
  tenant: TenantView;
  saved: ProfileView;
  isAdmin: boolean;
}) {
  const { api } = useApi();
  const [form, setForm] = useState<ProfileForm>(() =>
    saved.profile ? profileToForm(saved.profile) : blankForm(tenant.trade),
  );
  const [errors, setErrors] = useState<FormErrors>({});
  const [version, setVersion] = useState(saved.version);
  const [sync, setSync] = useState<SyncView | null>(saved.sync);
  const [slow, setSlow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<Error | null>(null);

  // While the newest version is going live, look again every few seconds, for two minutes.
  useEffect(() => {
    if (sync?.state !== "pending") return;
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      if (tries >= POLL_TRIES) {
        window.clearInterval(timer);
        setSlow(true);
      }
      void api<ProfileView>(`/tenants/${tenant.id}/profile`).then(
        (latest) => {
          if (latest.version === version && latest.sync) setSync(latest.sync);
        },
        () => undefined, // a failed look just waits for the next one
      );
    }, POLL_EVERY_MS);
    return () => window.clearInterval(timer);
    // Not `api`: it may be a new function on each render.
  }, [sync?.state, version, tenant.id]);

  const update = (change: Partial<ProfileForm>) =>
    setForm((current) => ({ ...current, ...change }));
  const updateDay = (day: Weekday, change: Partial<DayForm>) =>
    setForm((current) => ({
      ...current,
      hours: { ...current.hours, [day]: { ...current.hours[day], ...change } },
    }));
  const updateFaq = (index: number, change: Partial<FaqForm>) =>
    setForm((current) => ({
      ...current,
      faqs: current.faqs.map((faq, i) => (i === index ? { ...faq, ...change } : faq)),
    }));

  const save = async () => {
    const candidate = formToProfile(form);
    const checked = agentProfileInputSchema.safeParse(candidate);
    if (!checked.success) {
      setErrors(formErrors(checked.error.issues, candidate));
      return;
    }
    setErrors({});
    setSaving(true);
    setSaveError(null);
    try {
      const result = await api<SaveProfileView>(`/tenants/${tenant.id}/profile`, {
        method: "PUT",
        body: checked.data,
      });
      setVersion(result.version);
      setSlow(false);
      setSync(result.sync);
    } catch (caught) {
      setSaveError(asError(caught));
    } finally {
      setSaving(false);
    }
  };

  const hasErrors = Object.keys(errors).length > 0;
  return (
    <form
      className="profile"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <SyncStatus sync={sync} slow={slow} isAdmin={isAdmin} />

      <section className="card">
        <h2>Trade</h2>
        <select value={form.trade} onChange={(event) => update({ trade: event.target.value })}>
          {TRADES.map((trade) => (
            <option key={trade} value={trade}>
              {humanise(trade)}
            </option>
          ))}
        </select>
        <FieldErrors messages={errors.trade} />
      </section>

      <section className="card">
        <h2>Services</h2>
        <p className="hint">
          One per line. The assistant tells callers what you do. No prices: it never quotes them.
        </p>
        <textarea
          rows={5}
          value={form.services}
          placeholder={"Boiler repairs\nBurst pipes and leaks"}
          onChange={(event) => update({ services: event.target.value })}
        />
        <FieldErrors messages={errors.services} />
      </section>

      <section className="card">
        <h2>Areas you cover</h2>
        <p className="hint">One per line: towns or postcode areas.</p>
        <textarea
          rows={4}
          value={form.serviceAreas}
          placeholder={"Leeds\nLS6"}
          onChange={(event) => update({ serviceAreas: event.target.value })}
        />
        <FieldErrors messages={errors.serviceAreas} />
      </section>

      <section className="card">
        <h2>Opening hours</h2>
        <p className="hint">The assistant tells callers whether you're open right now.</p>
        <div className="hours">
          {WEEKDAYS.map((day) => {
            const slot = form.hours[day];
            return (
              <div key={day} className="hours-row">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={slot.open}
                    onChange={(event) => updateDay(day, { open: event.target.checked })}
                  />
                  {DAY_NAMES[day]}
                </label>
                {slot.open ? (
                  <span className="times">
                    <input
                      type="time"
                      aria-label={`${DAY_NAMES[day]} opens`}
                      value={slot.from}
                      onChange={(event) => updateDay(day, { from: event.target.value })}
                    />
                    to
                    <input
                      type="time"
                      aria-label={`${DAY_NAMES[day]} closes`}
                      value={slot.to}
                      onChange={(event) => updateDay(day, { to: event.target.value })}
                    />
                  </span>
                ) : (
                  <span className="muted">Closed</span>
                )}
              </div>
            );
          })}
        </div>
        <FieldErrors messages={errors.openingHours} />
      </section>

      <section className="card">
        <h2>Holiday</h2>
        <label className="check">
          <input
            type="checkbox"
            checked={form.holidayMode}
            onChange={(event) => update({ holidayMode: event.target.checked })}
          />
          I'm away. Callers are told, and you still get their messages.
        </label>
        {form.holidayMode && (
          <label className="stacked">
            Last day away (leave empty for "until I switch it off")
            <input
              type="date"
              value={form.holidayUntil}
              onChange={(event) => update({ holidayUntil: event.target.value })}
            />
          </label>
        )}
        <FieldErrors messages={errors.holidayUntil} />
      </section>

      <section className="card">
        <h2>Urgent call-outs</h2>
        <label className="check">
          <input
            type="checkbox"
            checked={form.takesEmergencyCalls}
            onChange={(event) => update({ takesEmergencyCalls: event.target.checked })}
          />
          I take urgent call-outs
        </label>
        <p className="hint">
          Unticked, the assistant still takes the message but won't suggest a quick response. Gas
          and safety warnings are always given, whatever this says.
        </p>
      </section>

      <section className="card">
        <h2>Questions callers ask</h2>
        <p className="hint">
          The assistant answers these in your words. Answers can't include prices or promise a time,
          because the assistant never does either.
        </p>
        {form.faqs.map((faq, index) => (
          <div key={index} className="faq">
            <label className="stacked">
              Question {index + 1}
              <input
                value={faq.question}
                onChange={(event) => updateFaq(index, { question: event.target.value })}
              />
            </label>
            <label className="stacked">
              Answer
              <textarea
                rows={2}
                value={faq.answer}
                onChange={(event) => updateFaq(index, { answer: event.target.value })}
              />
            </label>
            <button
              type="button"
              className="link"
              onClick={() =>
                setForm((current) => ({
                  ...current,
                  faqs: current.faqs.filter((_, i) => i !== index),
                }))
              }
            >
              Remove question {index + 1}
            </button>
          </div>
        ))}
        <button
          type="button"
          className="secondary"
          disabled={form.faqs.length >= PROFILE_LIMITS.faqs}
          onClick={() =>
            setForm((current) => ({
              ...current,
              faqs: [...current.faqs, { question: "", answer: "" }],
            }))
          }
        >
          Add a question
        </button>
        <FieldErrors messages={errors.faqs} />
      </section>

      <div className="save-bar">
        {hasErrors && (
          <p className="field-errors">Some details need changing. They're marked above.</p>
        )}
        {saveError && <ErrorNote error={saveError} />}
        <button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        {version !== null && <span className="muted">Version {version}</span>}
      </div>
    </form>
  );
}

function FieldErrors({ messages }: { messages: string[] | undefined }) {
  if (!messages || messages.length === 0) return null;
  return (
    <ul className="field-errors">
      {messages.map((message) => (
        <li key={message}>{message}</li>
      ))}
    </ul>
  );
}

function SyncStatus({
  sync,
  slow,
  isAdmin,
}: {
  sync: SyncView | null;
  slow: boolean;
  isAdmin: boolean;
}) {
  if (sync === null) {
    return (
      <p className="card notice">
        Not set up yet. Fill this in and save, and the assistant will use these details.
      </p>
    );
  }
  if (sync.state === "pending") {
    return (
      <p className="card notice">
        {slow
          ? "Saved. Updating the assistant is taking longer than usual; this page will show it once it's done."
          : "Saved. The assistant will be using these details in about a minute."}
      </p>
    );
  }
  if (sync.state === "live") {
    return (
      <p className="card notice ok">
        Live: the assistant is using these details
        {sync.syncedAt ? ` (updated ${formatUkDateTime(sync.syncedAt)})` : ""}.
      </p>
    );
  }
  return (
    <div className="card error">
      <p>
        Saved, but the assistant hasn't picked these details up. Try saving again in a few minutes,
        and contact support if it keeps happening.
      </p>
      {isAdmin && sync.error && <p className="muted">The voice platform said: {sync.error}</p>}
    </div>
  );
}
