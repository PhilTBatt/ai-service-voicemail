import { agentProfileInputSchema, type AgentProfileInput } from "@callmate/shared";
import { describe, expect, it } from "vitest";
import { blankForm, formErrors, formToProfile, profileToForm } from "./profile-form.ts";

const PROFILE: AgentProfileInput = {
  trade: "plumber",
  services: ["Boiler repairs", "Burst pipes"],
  serviceAreas: ["Leeds", "Bradford"],
  openingHours: {
    mon: { open: "08:00", close: "18:00" },
    tue: { open: "08:00", close: "18:00" },
    wed: { open: "08:00", close: "18:00" },
    thu: { open: "08:00", close: "18:00" },
    fri: { open: "08:00", close: "17:00" },
    sat: { open: "09:00", close: "13:00" },
    sun: null,
  },
  holidayMode: true,
  holidayUntil: "2026-12-31",
  faqs: [{ question: "Do you fit bathrooms?", answer: "Yes, Sam will talk it through." }],
  emergencyPolicy: { takesEmergencyCalls: true },
};

/** The form's sentences for a profile the schema refuses. */
function errorsFor(form: ReturnType<typeof blankForm>) {
  const profile = formToProfile(form);
  const result = agentProfileInputSchema.safeParse(profile);
  if (result.success) return {};
  return formErrors(result.error.issues, profile);
}

describe("profile form", () => {
  it("starts with weekday hours, closed weekends and urgent call-outs unticked", () => {
    const form = blankForm("electrician");
    expect(form.hours.mon).toEqual({ open: true, from: "08:00", to: "17:00" });
    expect(form.hours.sat.open).toBe(false);
    expect(form.takesEmergencyCalls).toBe(false);
    expect(agentProfileInputSchema.safeParse(formToProfile(form)).success).toBe(true);
  });

  it("gives back exactly the profile it was filled from", () => {
    expect(formToProfile(profileToForm(PROFILE))).toEqual(PROFILE);
  });

  it("reads one item per line, ignoring blank lines and stray spaces", () => {
    const form = { ...blankForm("plumber"), services: "  Boiler repairs \n\n Leaks\n" };
    expect(formToProfile(form).services).toEqual(["Boiler repairs", "Leaks"]);
  });

  it("drops the holiday date when holiday mode is off", () => {
    const form = { ...profileToForm(PROFILE), holidayMode: false };
    expect(formToProfile(form).holidayUntil).toBeNull();
  });

  it("says which line, day or question is wrong, in words", () => {
    const form = {
      ...profileToForm(PROFILE),
      services: "Boiler repairs\nBoiler service £80",
      hours: { ...profileToForm(PROFILE).hours, mon: { open: true, from: "18:00", to: "08:00" } },
      faqs: [{ question: "Call-out fee?", answer: "It's £60." }],
    };
    expect(errorsFor(form)).toEqual({
      services: ['"Boiler service £80": can\'t include prices: the assistant never quotes them'],
      openingHours: ["Monday: close must be after open"],
      faqs: ["Question 1, answer: can't include prices: the assistant never quotes them"],
    });
  });

  it("flags an empty question someone added and didn't fill in", () => {
    const form = { ...profileToForm(PROFILE), faqs: [{ question: "", answer: "" }] };
    expect(errorsFor(form).faqs).toEqual([
      "Question 1, question: can't be empty",
      "Question 1, answer: can't be empty",
    ]);
  });
});
