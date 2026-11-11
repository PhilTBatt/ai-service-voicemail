// The profile editor's conversions, field by field: what's saved comes back as it was typed,
// and each problem lands under the section the person is looking at.
import {
  agentProfileInputSchema,
  PROFILE_LIMITS,
  TRADES,
  WEEKDAYS,
  type AgentProfileInput,
} from "@callmate/shared";
import { describe, expect, it } from "vitest";
import {
  blankForm,
  formErrors,
  formToProfile,
  profileToForm,
  type ProfileForm,
} from "./profile-form.ts";

const BASE: AgentProfileInput = {
  trade: "plumber",
  services: ["Boiler repairs"],
  serviceAreas: ["Leeds"],
  openingHours: {
    mon: { open: "08:00", close: "17:00" },
    tue: null,
    wed: null,
    thu: null,
    fri: null,
    sat: null,
    sun: null,
  },
  holidayMode: false,
  holidayUntil: null,
  faqs: [],
  emergencyPolicy: { takesEmergencyCalls: false },
};

/**
 * Form to profile to form: what the page shows after saving and reloading. Through the schema,
 * as the page saves only what it accepts and the API stores what it parsed.
 */
const afterSaving = (form: ProfileForm) =>
  profileToForm(agentProfileInputSchema.parse(formToProfile(form)));

function problems(form: ProfileForm) {
  const profile = formToProfile(form);
  const result = agentProfileInputSchema.safeParse(profile);
  return result.success ? {} : formErrors(result.error.issues, profile);
}

describe("profile to form to profile", () => {
  it.each<[string, Partial<AgentProfileInput>]>([
    ["every trade", {}],
    ["no services or areas", { services: [], serviceAreas: [] }],
    [
      "the most services and areas allowed",
      {
        services: Array.from({ length: PROFILE_LIMITS.services }, (_, i) => `Service ${i + 1}`),
        serviceAreas: Array.from({ length: PROFILE_LIMITS.serviceAreas }, (_, i) => `LS${i + 1}`),
      },
    ],
    [
      "Welsh, accents and an emoji",
      {
        services: ["Gwaith plymio", "Réparations", "Leaks 🔧"],
        serviceAreas: ["Llanfairpwllgwyngyll", "Ynys Môn"],
      },
    ],
    [
      "every day open, to the minute",
      {
        openingHours: Object.fromEntries(
          WEEKDAYS.map((day, i) => [day, { open: `0${i}:15`, close: `2${i % 4}:45` }]),
        ),
      },
    ],
    ["every day closed", { openingHours: Object.fromEntries(WEEKDAYS.map((d) => [d, null])) }],
    ["holiday with no end date", { holidayMode: true, holidayUntil: null }],
    ["holiday to a leap day", { holidayMode: true, holidayUntil: "2028-02-29" }],
    ["urgent call-outs taken", { emergencyPolicy: { takesEmergencyCalls: true } }],
    [
      "the most questions allowed",
      {
        faqs: Array.from({ length: PROFILE_LIMITS.faqs }, (_, i) => ({
          question: `Do you do job ${i + 1}?`,
          answer: "Yes, Sam will talk it through.",
        })),
      },
    ],
  ])("keeps %s exactly", (_, change) => {
    const profile = { ...BASE, ...change };
    expect(agentProfileInputSchema.safeParse(profile).success).toBe(true);
    expect(formToProfile(profileToForm(profile))).toEqual(profile);
  });

  it("keeps every trade", () => {
    for (const trade of TRADES) {
      expect(formToProfile(profileToForm({ ...BASE, trade })).trade).toBe(trade);
    }
  });

  it("reads a day the profile leaves out as closed", () => {
    const form = profileToForm({
      ...BASE,
      openingHours: { mon: { open: "09:00", close: "12:00" } },
    });
    expect(form.hours.tue.open).toBe(false);
    expect(formToProfile(form).openingHours.tue).toBeNull();
  });
});

describe("form to profile to form", () => {
  it("gives back an untouched blank form, for every trade, and the schema accepts it", () => {
    for (const trade of TRADES) {
      const form = blankForm(trade);
      expect(afterSaving(form)).toEqual(form);
      expect(agentProfileInputSchema.safeParse(formToProfile(form)).success, trade).toBe(true);
    }
  });

  it("tidies lists as they're saved: trimmed, no blank lines, Windows line endings too", () => {
    const form = { ...blankForm("plumber"), services: " Leaks \r\n\r\n\tBoilers\n  \n" };
    expect(formToProfile(form).services).toEqual(["Leaks", "Boilers"]);
    expect(afterSaving(form).services).toBe("Leaks\nBoilers");
  });

  it("forgets a closed day's times, which nobody can see while it's closed", () => {
    const form = blankForm("plumber");
    form.hours.sat = { open: false, from: "10:00", to: "14:00" };
    expect(afterSaving(form).hours.sat).toEqual({ open: false, from: "08:00", to: "17:00" });
  });

  it("forgets the holiday date when holiday mode is off, and keeps it when on", () => {
    const away = { ...blankForm("plumber"), holidayMode: true, holidayUntil: "2026-12-31" };
    expect(afterSaving(away).holidayUntil).toBe("2026-12-31");
    expect(afterSaving({ ...away, holidayMode: false }).holidayUntil).toBe("");
  });

  it("saves an empty holiday date as 'until I switch it off'", () => {
    const form = { ...blankForm("plumber"), holidayMode: true, holidayUntil: "" };
    expect(formToProfile(form).holidayUntil).toBeNull();
  });

  it("keeps each question with its own answer, in order", () => {
    const faqs = [
      { question: "Weekends?", answer: "Saturdays, yes." },
      { question: "Gas Safe?", answer: "Yes, registered." },
    ];
    expect(afterSaving({ ...blankForm("plumber"), faqs }).faqs).toEqual(faqs);
  });
});

describe("where each problem is shown", () => {
  it("quotes the right line even with blank lines before it", () => {
    const form = { ...blankForm("plumber"), services: "Leaks\n\n\nBoiler service £80" };
    expect(problems(form).services).toEqual([
      '"Boiler service £80": can\'t include prices: the assistant never quotes them',
    ]);
  });

  it("refuses a price in an area, which the assistant reads out too", () => {
    const form = { ...blankForm("plumber"), serviceAreas: "Leeds\nBradford (£20 travel)" };
    expect(problems(form).serviceAreas).toEqual([
      '"Bradford (£20 travel)": can\'t include prices: the assistant never quotes them',
    ]);
  });

  it("says too many services once, for the list, not line by line", () => {
    const form = {
      ...blankForm("plumber"),
      services: Array.from({ length: PROFILE_LIMITS.services + 1 }, (_, i) => `S${i}`).join("\n"),
    };
    expect(problems(form).services).toEqual([`${PROFILE_LIMITS.services} at most`]);
  });

  it("names each day with bad hours, in the week's order", () => {
    const form = blankForm("plumber");
    form.hours.fri = { open: true, from: "17:00", to: "08:00" };
    form.hours.mon = { open: true, from: "12:00", to: "12:00" };
    expect(problems(form).openingHours).toEqual([
      "Monday: close must be after open",
      "Friday: close must be after open",
    ]);
  });

  it("ignores the hours of a closed day, however wrong", () => {
    const form = blankForm("plumber");
    form.hours.sun = { open: false, from: "23:00", to: "01:00" };
    expect(problems(form)).toEqual({});
  });

  it("refuses an unknown trade under the trade, and a promised time in an answer", () => {
    const form = {
      ...blankForm("not_a_trade"),
      faqs: [{ question: "How soon?", answer: "We'll be there within the hour." }],
    };
    const found = problems(form);
    expect(found.trade).toHaveLength(1);
    expect(found.faqs).toEqual([
      "Question 1, answer: can't promise a time: the assistant never commits to one",
    ]);
  });

  it("numbers questions from 1 as the page does, past the first", () => {
    const form = {
      ...blankForm("plumber"),
      faqs: [
        { question: "Weekends?", answer: "Yes." },
        { question: "Weekends?", answer: "" },
      ],
    };
    expect(problems(form).faqs).toEqual(["Question 2, answer: can't be empty"]);
  });

  it("says too many questions once", () => {
    const form = {
      ...blankForm("plumber"),
      faqs: Array.from({ length: PROFILE_LIMITS.faqs + 1 }, () => ({
        question: "Q?",
        answer: "A.",
      })),
    };
    expect(problems(form).faqs).toEqual([`${PROFILE_LIMITS.faqs} at most`]);
  });
});
