import { storedAgentProfileSchema } from "@callmate/shared";
import { z } from "zod";

// What the prompt builder needs to know about a tenant. The sync job assembles it from the
// tenants and agent_profiles tables, and these schemas validate the jsonb columns on the
// way in (a profile saved by an older version of the dashboard is external input too).
// The editable part, and its rules, live in packages/shared/src/profile.ts.

export {
  WEEKDAYS,
  emergencyPolicySchema,
  faqSchema,
  openingHoursSchema,
  type Faq,
  type OpeningHours,
  type Weekday,
} from "@callmate/shared";

// Built from the stored shape, not the editor's checks: a profile saved before a check got
// stricter must still sync (packages/shared/src/profile.ts).
export const tenantProfileSchema = storedAgentProfileSchema.extend({
  tenantId: z.uuid(),
  profileVersion: z.number().int().positive(),
  businessName: z.string().min(1),
  /** Appendix A's {Name}: who the caller is told will ring them back. */
  tradespersonName: z.string().min(1),
  /** Decides which gas emergency number the agent gives. */
  serviceRegion: z.enum(["GB", "NI"]),
  /** Demo tenants get shorter calls (Appendix B). */
  isDemo: z.boolean(),
});
export type TenantProfile = z.infer<typeof tenantProfileSchema>;
