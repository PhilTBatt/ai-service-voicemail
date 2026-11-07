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

/** The tables a business can download as CSV (BUILD_PLAN Step 13), with what the page calls them. */
export const CSV_EXPORTS = ["business", "calls", "messages", "assistant", "account-log"] as const;
export type CsvExport = (typeof CSV_EXPORTS)[number];
export const CSV_EXPORT_LABELS: Record<CsvExport, string> = {
  business: "Business details",
  calls: "Calls",
  messages: "Messages we sent",
  assistant: "Assistant settings",
  "account-log": "Account log",
};
