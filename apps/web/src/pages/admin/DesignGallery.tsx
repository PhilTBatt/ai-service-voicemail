// The component gallery (docs/UI.md): every component of the design system in its states, on
// one page, in whichever colours are switched on. Look here after changing a token or a
// component, in light and dark, before it reaches a screen. Fictional content only.
import { useState } from "react";
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  Checkbox,
  CopyCode,
  DescriptionList,
  EmptyState,
  Loading,
  Meter,
  RadioGroup,
  SectionHeader,
  Segmented,
  SelectField,
  Stat,
  Switch,
  TextAreaField,
  TextField,
  ToggleChip,
  type Tone,
} from "../../design/components.tsx";
import { useConfirm } from "../../design/dialog.tsx";
import { Inbox, MessageSquare, Phone, Plus, Power, Sparkles, Trash } from "../../design/icons.ts";
import { useToast } from "../../design/toast.tsx";
import { StatusBadge, UrgencyBadge } from "../../ui.tsx";

const TONES: Tone[] = ["neutral", "brand", "info", "success", "warning", "danger"];

export function DesignGallery() {
  const confirm = useConfirm();
  const toast = useToast();
  const [segment, setSegment] = useState("all");
  const [chip, setChip] = useState(true);
  const [on, setOn] = useState(true);
  const [ticked, setTicked] = useState(false);
  const [radio, setRadio] = useState<"yes" | "no" | "">("");

  return (
    <div className="stack stack-xl">
      <p className="muted">
        Every component in its states (docs/UI.md, section 4). Switch the colours at the bottom of
        the menu to check dark mode.
      </p>

      <section className="stack">
        <SectionHeader title="Tones" description="What a colour means, used the same everywhere." />
        <div className="cluster">
          {TONES.map((tone) => (
            <Badge key={tone} tone={tone} dot>
              {tone}
            </Badge>
          ))}
        </div>
        <div className="cluster">
          {["emergency", "urgent", "routine", "spam", null].map((urgency) => (
            <UrgencyBadge key={urgency ?? "none"} urgency={urgency} />
          ))}
          {["live", "paused", "onboarding", "suspended", "cancelling", "cancelled", "demo"].map(
            (status) => (
              <StatusBadge key={status} status={status} />
            ),
          )}
        </div>
      </section>

      <section className="stack">
        <SectionHeader title="Buttons" />
        <div className="cluster">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="link">Link</Button>
        </div>
        <div className="cluster">
          <Button size="sm" icon={Plus}>
            Small
          </Button>
          <Button icon={Phone}>With an icon</Button>
          <Button size="lg">Large</Button>
          <Button loading>Loading</Button>
          <Button disabled>Disabled</Button>
          <Button variant="ghost" iconOnly icon={Trash} aria-label="Delete (an example)" />
        </div>
      </section>

      <section className="stack">
        <SectionHeader title="Alerts" />
        {(["info", "success", "warning", "danger"] as const).map((tone) => (
          <Alert key={tone} tone={tone} title={`${tone[0]!.toUpperCase()}${tone.slice(1)} alert`}>
            <p>Something to read, with what to do about it.</p>
          </Alert>
        ))}
      </section>

      <section className="stack">
        <SectionHeader title="Cards" />
        <div className="grid">
          <Card icon={Sparkles} title="A card" description="With an icon and a description.">
            <p>Its body: children are spaced evenly.</p>
          </Card>
          <Card
            title="With a footer"
            footer={
              <>
                <Button>Save</Button>
                <Button variant="ghost">Cancel</Button>
              </>
            }
          >
            <p>Buttons go in the footer.</p>
          </Card>
          <Card icon={Power} tone="danger" title="A danger card">
            <p>For something final or broken.</p>
          </Card>
        </div>
      </section>

      <section className="stack">
        <SectionHeader title="Numbers" />
        <div className="grid grid-stats">
          <Stat label="Calls this week" value={42} icon={Phone} />
          <Stat label="Answering" value={12} tone="success" />
          <Stat label="Failed" value={3} tone="danger" hint="Last 24 hours" />
        </div>
        <Card>
          <Meter value={120} max={200} label="An example: 120 of 200 minutes" />
          <Meter value={230} max={200} label="An example: over the limit" />
          <DescriptionList
            items={[
              { term: "Name", detail: "Robin Ash" },
              { term: "Postcode", detail: "XQ1 2AB" },
            ]}
          />
          <div className="cluster">
            <Avatar name="Robin Ash" tone="warning" />
            <Avatar name="Fern Lane Plumbing" tone="success" square />
            <Avatar name={null} />
            <CopyCode code="**61*901#" />
          </div>
        </Card>
      </section>

      <section className="stack">
        <SectionHeader title="Fields" />
        <Card>
          <TextField label="A text field" hint="A hint under the label." placeholder="Typed here" />
          <TextField label="With an error" defaultValue="0770" error="Enter a UK mobile number" />
          <SelectField label="A choice" defaultValue="b">
            <option value="a">First</option>
            <option value="b">Second</option>
          </SelectField>
          <TextAreaField label="A longer answer" rows={3} />
          <Checkbox
            label="A tick box"
            description="With a line under it."
            checked={ticked}
            onChange={(event) => setTicked(event.target.checked)}
          />
          <Switch
            label="A switch"
            description="For a setting that's on or off."
            checked={on}
            onChange={(event) => setOn(event.target.checked)}
          />
          <RadioGroup
            legend="A question with a few answers"
            name="gallery-radio"
            options={[
              { value: "yes", label: "Yes" },
              { value: "no", label: "No" },
            ]}
            value={radio}
            onChange={setRadio}
            inline
          />
        </Card>
      </section>

      <section className="stack">
        <SectionHeader title="Filters" />
        <div className="toolbar">
          <Segmented
            label="An example filter"
            options={[
              { value: "all", label: "All" },
              { value: "some", label: "Some" },
              { value: "none", label: "None" },
            ]}
            value={segment}
            onChange={setSegment}
          />
          <ToggleChip pressed={chip} icon={MessageSquare} onChange={setChip}>
            A toggle
          </ToggleChip>
        </div>
      </section>

      <section className="stack">
        <SectionHeader title="Empty and loading" />
        <div className="grid">
          <div className="card">
            <EmptyState
              icon={Inbox}
              title="Nothing here yet"
              action={<Button variant="secondary">Do the first one</Button>}
            >
              What will appear here, and how.
            </EmptyState>
          </div>
          <div className="card card-body">
            <Loading label="An example loading" />
          </div>
        </div>
      </section>

      <section className="stack">
        <SectionHeader title="Dialogs and toasts" />
        <div className="cluster">
          <Button
            variant="secondary"
            onClick={() =>
              void confirm({
                title: "A question",
                body: "What will happen if you go ahead.",
                confirmLabel: "Go ahead",
              })
            }
          >
            Open a dialog
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              void confirm({
                title: "Something final",
                body: "It can't be undone.",
                confirmLabel: "Do it",
                tone: "danger",
                requireText: "Fern Lane Plumbing",
                requireLabel: "Type the name to go ahead",
              })
            }
          >
            Open a typed confirmation
          </Button>
          <Button variant="secondary" onClick={() => toast({ title: "Saved" })}>
            Show a toast
          </Button>
        </div>
      </section>
    </div>
  );
}
