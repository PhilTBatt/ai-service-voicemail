// The agent profile a tenant edits (BUILD_PLAN Step 10): what the dashboard's editor sends
// and the API stores. One schema for both, so the browser shows the same errors the API would
// give. The API's full profile (apps/api/src/core/profile.ts) adds the tenant's own details.
//
// Tenants write text the agent reads out (services, FAQ answers), so that text is held to the
// agent's own rules: no prices and no promised times, checked with the same patterns the
// post-call scan uses. The length limits keep the prompt a sensible size.
import { z } from "zod";
import { mentionsPrice, promisesTime } from "./guardrail-patterns.ts";
import { TRADES } from "./trades.ts";

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM");

/** Open and close times per day. A null or missing day is closed. */
export const openingHoursSchema = z.partialRecord(
  z.enum(WEEKDAYS),
  z
    .object({ open: hhmm, close: hhmm })
    // isOpenAt() treats close as the same day, so an overnight slot would read as always closed.
    .refine((slot) => slot.close > slot.open, { message: "close must be after open" })
    .nullable(),
);
export type OpeningHours = z.infer<typeof openingHoursSchema>;

/** Text the agent may say to a caller, written by the tenant. */
function spoken(maxLength: number) {
  return z
    .string()
    .trim()
    .min(1, "can't be empty")
    .max(maxLength, `keep it under ${maxLength} characters`)
    .refine((text) => !mentionsPrice(text), "can't include prices: the assistant never quotes them")
    .refine(
      (text) => !promisesTime(text),
      "can't promise a time: the assistant never commits to one",
    );
}

export const faqSchema = z.object({
  question: z.string().trim().min(1, "can't be empty").max(200, "keep it under 200 characters"),
  answer: spoken(600),
});
export type Faq = z.infer<typeof faqSchema>;

export const emergencyPolicySchema = z.object({ takesEmergencyCalls: z.boolean() });

export const PROFILE_LIMITS = { services: 25, serviceAreas: 25, faqs: 15 } as const;

/** What a tenant (or admin) edits. Everything else on the profile comes from the tenant row. */
export const agentProfileInputSchema = z.object({
  trade: z.enum(TRADES),
  services: z.array(spoken(80)).max(PROFILE_LIMITS.services, `${PROFILE_LIMITS.services} at most`),
  serviceAreas: z
    .array(z.string().trim().min(1, "can't be empty").max(60, "keep it under 60 characters"))
    .max(PROFILE_LIMITS.serviceAreas, `${PROFILE_LIMITS.serviceAreas} at most`),
  openingHours: openingHoursSchema,
  holidayMode: z.boolean(),
  /** ISO date (YYYY-MM-DD), or null for "until further notice". */
  holidayUntil: z.iso.date().nullable(),
  faqs: z.array(faqSchema).max(PROFILE_LIMITS.faqs, `${PROFILE_LIMITS.faqs} at most`),
  emergencyPolicy: emergencyPolicySchema,
});
export type AgentProfileInput = z.infer<typeof agentProfileInputSchema>;
