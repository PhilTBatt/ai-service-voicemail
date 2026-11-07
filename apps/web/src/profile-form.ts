// The profile editor's form, and the conversions to and from the API's profile. Lists are
// edited as text, one item per line, because that's the quickest thing to type on a phone.
// Checking uses the API's own schema (packages/shared/src/profile.ts), so the page shows the
// same problems the API would refuse.
import {
  WEEKDAYS,
  type AgentProfileInput,
  type OpeningHours,
  type Weekday,
} from "@callmate/shared";

export const DAY_NAMES: Record<Weekday, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

export interface DayForm {
  open: boolean;
  from: string;
  to: string;
}

export interface FaqForm {
  question: string;
  answer: string;
}

export interface ProfileForm {
  trade: string;
  /** One per line. */
  services: string;
  /** One per line. */
  serviceAreas: string;
  hours: Record<Weekday, DayForm>;
  holidayMode: boolean;
  /** YYYY-MM-DD, the last day away; "" for "until I switch it off". */
  holidayUntil: string;
  faqs: FaqForm[];
  takesEmergencyCalls: boolean;
}

const closed = (): DayForm => ({ open: false, from: "08:00", to: "17:00" });

function eachDay(make: (day: Weekday) => DayForm): Record<Weekday, DayForm> {
  return Object.fromEntries(WEEKDAYS.map((day) => [day, make(day)])) as Record<Weekday, DayForm>;
}

/**
 * A first profile: weekdays 8 to 5, closed at weekends, nothing else filled in. Urgent
 * call-outs start unticked, so the assistant never implies a service the tenant hasn't offered.
 */
export function blankForm(trade: string): ProfileForm {
  return {
    trade,
    services: "",
    serviceAreas: "",
    hours: eachDay((day) =>
      day === "sat" || day === "sun" ? closed() : { open: true, from: "08:00", to: "17:00" },
    ),
    holidayMode: false,
    holidayUntil: "",
    faqs: [],
    takesEmergencyCalls: false,
  };
}

export function profileToForm(profile: AgentProfileInput): ProfileForm {
  return {
    trade: profile.trade,
    services: profile.services.join("\n"),
    serviceAreas: profile.serviceAreas.join("\n"),
    hours: eachDay((day) => {
      const slot = profile.openingHours[day];
      return slot ? { open: true, from: slot.open, to: slot.close } : closed();
    }),
    holidayMode: profile.holidayMode,
    holidayUntil: profile.holidayUntil ?? "",
    faqs: profile.faqs.map((faq) => ({ question: faq.question, answer: faq.answer })),
    takesEmergencyCalls: profile.emergencyPolicy.takesEmergencyCalls,
  };
}

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** What the form would save. Not yet checked: run it through agentProfileInputSchema. */
export function formToProfile(form: ProfileForm) {
  const openingHours: OpeningHours = {};
  for (const day of WEEKDAYS) {
    const slot = form.hours[day];
    openingHours[day] = slot.open ? { open: slot.from, close: slot.to } : null;
  }
  return {
    trade: form.trade,
    services: lines(form.services),
    serviceAreas: lines(form.serviceAreas),
    openingHours,
    holidayMode: form.holidayMode,
    holidayUntil: form.holidayMode && form.holidayUntil !== "" ? form.holidayUntil : null,
    faqs: form.faqs,
    emergencyPolicy: { takesEmergencyCalls: form.takesEmergencyCalls },
  };
}

export type FormSection =
  "trade" | "services" | "serviceAreas" | "openingHours" | "holidayUntil" | "faqs";

export type FormErrors = Partial<Record<FormSection, string[]>>;

/** Turns the schema's problems into sentences, placed under the section they belong to. */
export function formErrors(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
  profile: ReturnType<typeof formToProfile>,
): FormErrors {
  const errors: FormErrors = {};
  for (const issue of issues) {
    const [field, index, part] = issue.path;
    const section = String(field) as FormSection;
    let text = issue.message;
    if ((section === "services" || section === "serviceAreas") && typeof index === "number") {
      text = `"${profile[section][index] ?? ""}": ${issue.message}`;
    } else if (section === "faqs" && typeof index === "number") {
      text = `Question ${index + 1}${typeof part === "string" ? `, ${part}` : ""}: ${issue.message}`;
    } else if (section === "openingHours" && typeof index === "string") {
      text = `${DAY_NAMES[index as Weekday] ?? index}: ${issue.message}`;
    }
    (errors[section] ??= []).push(text);
  }
  return errors;
}
