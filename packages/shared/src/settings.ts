// Where a tenant's messages go (BUILD_PLAN Step 10). Shared so the dashboard checks the
// settings exactly as the API does before saving them.
import { z } from "zod";

/** A UK mobile in E.164 form: +447 and nine more digits. Texts go nowhere else. */
export const ukMobileSchema = z
  .string()
  .regex(/^\+447\d{9}$/, "must be a UK mobile like +447700900123");

export const notificationSettingsSchema = z.object({
  /** Null stops texts, emergency texts included. */
  notificationMobile: ukMobileSchema.nullable(),
  notificationEmail: z.email("must be an email address").nullable(),
});
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;
