import { TRADES } from "@callmate/shared";
import { z } from "zod";

// What the prompt builder needs to know about a tenant. The sync job assembles it from the
// tenants and agent_profiles tables, and these schemas validate the jsonb columns on the
// way in (a profile saved by an older version of the dashboard is external input too).

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

export const faqSchema = z.object({ question: z.string().min(1), answer: z.string().min(1) });
export type Faq = z.infer<typeof faqSchema>;

export const emergencyPolicySchema = z.object({ takesEmergencyCalls: z.boolean() });

export const tenantProfileSchema = z.object({
  tenantId: z.uuid(),
  profileVersion: z.number().int().positive(),
  businessName: z.string().min(1),
  /** Appendix A's {Name}: who the caller is told will ring them back. */
  tradespersonName: z.string().min(1),
  trade: z.enum(TRADES),
  /** Decides which gas emergency number the agent gives. */
  serviceRegion: z.enum(["GB", "NI"]),
  /** Demo tenants get shorter calls (Appendix B). */
  isDemo: z.boolean(),
  services: z.array(z.string().min(1)),
  serviceAreas: z.array(z.string().min(1)),
  openingHours: openingHoursSchema,
  holidayMode: z.boolean(),
  /** ISO date (YYYY-MM-DD), or null for "until further notice". */
  holidayUntil: z.iso.date().nullable(),
  faqs: z.array(faqSchema),
  emergencyPolicy: emergencyPolicySchema,
});
export type TenantProfile = z.infer<typeof tenantProfileSchema>;
