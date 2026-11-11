// What the assistant knows about one business: trade, services, areas, hours, holidays,
// urgent call-outs and the questions callers ask. Saving makes a new version; the worker sends
// it to the voice platform, and this page shows when the assistant is using it.
import {
  agentProfileInputSchema,
  PROFILE_LIMITS,
  TRADES,
  WEEKDAYS,
  type ProfileView,
  type SaveProfileView,
  type SyncView,
  type TenantView,
  type Weekday,
} from "@callmate/shared";
import { useEffect, useState } from "react";
import { asError, useApi, useLoad } from "../api.ts";
import {
  Alert,
  Button,
  Card,
  ErrorNote,
  FieldErrors,
  Loading,
  SectionHeader,
  SelectField,
  Switch,
  TextAreaField,
  TextField,
} from "../design/components.tsx";
import {
  Clock,
  MapPin,
  MessageSquare,
  Plus,
  Siren,
  Trash,
  TreePalm,
  Wrench,
} from "../design/icons.ts";
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
import { useTenant } from "../tenant-layout.tsx";
import { formatUkDateTime } from "../time.ts";

export function ProfilePage() {
  const { me, tenant } = useTenant();
  const { api } = useApi();
  const saved = useLoad(() => api<ProfileView>(`/tenants/${tenant.id}/profile`), tenant.id);

  if (saved.status === "loading") return <Loading label="Loading the assistant's details…" />;
  if (saved.status === "error") return <ErrorNote error={saved.error} retry={saved.reload} />;
  return (
    <ProfileEditor
      key={tenant.id}
      tenant={tenant}
      saved={saved.data}
      isAdmin={me.role === "admin"}
    />
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
      className="form-sections"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <SectionHeader
        title="Assistant"
        description="What the assistant tells your callers. Save, and it uses the new details within a minute or so."
      />
      <SyncStatus sync={sync} slow={slow} isAdmin={isAdmin} />

      <Card icon={Wrench} title="Your trade and services">
        <SelectField
          label="Trade"
          value={form.trade}
          error={errors.trade}
          onChange={(event) => update({ trade: event.target.value })}
        >
          {TRADES.map((trade) => (
            <option key={trade} value={trade}>
              {humanise(trade)}
            </option>
          ))}
        </SelectField>
        <TextAreaField
          label="Services, one per line"
          hint="The assistant tells callers what you do. No prices: it never quotes them."
          rows={5}
          value={form.services}
          placeholder={"Boiler repairs\nBurst pipes and leaks"}
          error={errors.services}
          onChange={(event) => update({ services: event.target.value })}
        />
      </Card>

      <Card icon={MapPin} title="Areas you cover">
        <TextAreaField
          label="Areas you cover, one per line"
          hideLabel
          hint="One per line: towns or postcode areas."
          rows={4}
          value={form.serviceAreas}
          placeholder={"Leeds\nLS6"}
          error={errors.serviceAreas}
          onChange={(event) => update({ serviceAreas: event.target.value })}
        />
      </Card>

      <Card
        icon={Clock}
        title="Opening hours"
        description="The assistant tells callers whether you're open right now."
      >
        <div className="hours">
          {WEEKDAYS.map((day) => {
            const slot = form.hours[day];
            return (
              <div key={day} className="hours-row">
                <Switch
                  label={DAY_NAMES[day]}
                  checked={slot.open}
                  onChange={(event) => updateDay(day, { open: event.target.checked })}
                />
                {slot.open ? (
                  <span className="times">
                    <input
                      type="time"
                      className="input"
                      aria-label={`${DAY_NAMES[day]} opens`}
                      value={slot.from}
                      onChange={(event) => updateDay(day, { from: event.target.value })}
                    />
                    to
                    <input
                      type="time"
                      className="input"
                      aria-label={`${DAY_NAMES[day]} closes`}
                      value={slot.to}
                      onChange={(event) => updateDay(day, { to: event.target.value })}
                    />
                  </span>
                ) : (
                  <span className="muted text-sm">Closed</span>
                )}
              </div>
            );
          })}
        </div>
        <FieldErrors messages={errors.openingHours} />
      </Card>

      <Card icon={TreePalm} title="Holiday">
        <Switch
          label="I'm away"
          description="Callers are told, and you still get their messages."
          checked={form.holidayMode}
          onChange={(event) => update({ holidayMode: event.target.checked })}
        />
        {form.holidayMode && (
          <TextField
            label="Last day away"
            hint={`Leave empty for "until I switch it off".`}
            type="date"
            className="input-auto"
            value={form.holidayUntil}
            error={errors.holidayUntil}
            onChange={(event) => update({ holidayUntil: event.target.value })}
          />
        )}
        {!form.holidayMode && <FieldErrors messages={errors.holidayUntil} />}
      </Card>

      <Card icon={Siren} title="Urgent call-outs">
        <Switch
          label="I take urgent call-outs"
          description="Off, the assistant still takes the message but won't suggest a quick response. Gas and safety warnings are always given, whatever this says."
          checked={form.takesEmergencyCalls}
          onChange={(event) => update({ takesEmergencyCalls: event.target.checked })}
        />
      </Card>

      <Card
        icon={MessageSquare}
        title="Questions callers ask"
        description="The assistant answers these in your words. Answers can't include prices or promise a time, because the assistant never does either."
        footer={
          <Button
            variant="secondary"
            icon={Plus}
            disabled={form.faqs.length >= PROFILE_LIMITS.faqs}
            onClick={() =>
              setForm((current) => ({
                ...current,
                faqs: [...current.faqs, { question: "", answer: "" }],
              }))
            }
          >
            Add a question
          </Button>
        }
      >
        {form.faqs.length === 0 && (
          <p className="muted text-sm">
            None yet. Add the ones you're asked most: whether you do weekends, say.
          </p>
        )}
        {form.faqs.map((faq, index) => (
          <div key={index} className="faq">
            <TextField
              label={`Question ${index + 1}`}
              value={faq.question}
              onChange={(event) => updateFaq(index, { question: event.target.value })}
            />
            <TextAreaField
              label="Answer"
              rows={2}
              value={faq.answer}
              onChange={(event) => updateFaq(index, { answer: event.target.value })}
            />
            <div>
              <Button
                variant="ghost"
                size="sm"
                icon={Trash}
                onClick={() =>
                  setForm((current) => ({
                    ...current,
                    faqs: current.faqs.filter((_, i) => i !== index),
                  }))
                }
              >
                Remove<span className="sr-only"> question {index + 1}</span>
              </Button>
            </div>
          </div>
        ))}
        <FieldErrors messages={errors.faqs} />
      </Card>

      <div className="save-bar">
        <div className="stack stack-xs">
          {hasErrors ? (
            <FieldErrors messages={["Some details need changing. They're marked above."]} />
          ) : (
            <span className="muted text-sm">
              {version !== null ? `Version ${version}` : "Not saved yet"}
            </span>
          )}
          {saveError && <ErrorNote error={saveError} />}
        </div>
        <Button type="submit" loading={saving}>
          Save
        </Button>
      </div>
    </form>
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
      <Alert tone="info">
        <p>Not set up yet. Fill this in and save, and the assistant will use these details.</p>
      </Alert>
    );
  }
  if (sync.state === "pending") {
    return (
      <Alert tone="info">
        <p>
          {slow
            ? "Saved. Updating the assistant is taking longer than usual; this page will show it once it's done."
            : "Saved. The assistant will be using these details in about a minute."}
        </p>
      </Alert>
    );
  }
  if (sync.state === "live") {
    return (
      <Alert tone="success">
        <p>
          Live: the assistant is using these details
          {sync.syncedAt ? ` (updated ${formatUkDateTime(sync.syncedAt)})` : ""}.
        </p>
      </Alert>
    );
  }
  return (
    <Alert tone="danger" title="The assistant hasn't picked these details up">
      <p>Try saving again in a few minutes, and contact support if it keeps happening.</p>
      {isAdmin && sync.error && <p className="muted">The voice platform said: {sync.error}</p>}
    </Alert>
  );
}
