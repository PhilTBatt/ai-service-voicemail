// Where a tenant's messages go (BUILD_PLAN Step 10). Shared so the dashboard checks the
// settings exactly as the API does before saving them.
import { z } from "zod";

/** A UK mobile in E.164 form: +447 and nine more digits. Texts go nowhere else. */
export const ukMobileSchema = z
  .string()
  .regex(/^\+447\d{9}$/, "must be a UK mobile like +447700900123");

/**
 * The longest email address that can be delivered: RFC 5321 limits the path an address travels
 * in to 256 characters, two of them its angle brackets (RFC 3696's erratum 1690 says the same).
 * Anything longer would be saved, then refused by the email provider on every send.
 */
export const EMAIL_MAX_LENGTH = 254;

/** An email address someone types in: the dashboard's settings and the signup form. */
export const emailAddressSchema = z
  .email("must be an email address")
  .max(EMAIL_MAX_LENGTH, `keep it to ${EMAIL_MAX_LENGTH} characters or fewer`);

export const notificationSettingsSchema = z.object({
  /** Null stops texts, emergency texts included. */
  notificationMobile: ukMobileSchema.nullable(),
  notificationEmail: emailAddressSchema.nullable(),
});
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

/**
 * A new mobile is confirmed by a code texted to it before texts go there (PROGRESS open
 * question 4): the owner types the 6 digits back.
 */
export const MOBILE_CODE_LENGTH = 6;
export const confirmMobileSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(new RegExp(`^\\d{${MOBILE_CODE_LENGTH}}$`), `the code is ${MOBILE_CODE_LENGTH} digits`),
});

/** The tables a business can download as CSV (BUILD_PLAN Step 13), with what the page calls them. */
export const CSV_EXPORTS = [
  "business",
  "calls",
  "messages",
  "assistant",
  "account-log",
  "billing",
  "people",
  "payment-events",
  "billing-emails",
  "suspensions",
] as const;
export type CsvExport = (typeof CSV_EXPORTS)[number];
export const CSV_EXPORT_LABELS: Record<CsvExport, string> = {
  business: "Business details",
  calls: "Calls",
  messages: "Messages we sent",
  assistant: "Assistant settings",
  "account-log": "Account log",
  billing: "Billing",
  people: "People with access",
  "payment-events": "Direct Debit events",
  "billing-emails": "Billing emails",
  suspensions: "Suspensions",
};
