import { logger } from "./logger.ts";

/**
 * Every alert the service raises. RUNBOOK section 11 says what each one means and the first
 * three things to check, and alerts.test.ts makes sure each has a test that fires it and a
 * runbook entry (BUILD_PLAN Step 15: "every alert has fired at least once in testing").
 */
export const ALERTS = [
  "job-dead-lettered",
  "voice-platform-unreachable",
  "agent-sync-failed",
  "call-extraction-failed",
  "summary-judge-failed",
  "guardrail-hit",
  "notification-no-mobile",
  "notification-no-email",
  "sms-undelivered",
  "recipient-opted-out",
  "email-bounced",
  "email-spam-complaint",
  "number-bought-not-recorded",
  "deletion-confirmation-not-sent",
] as const;

export type AlertName = (typeof ALERTS)[number];

/**
 * Something a person needs to see soon. For now it's an error-level log line carrying an
 * `alert` field; Step 8 routes those lines to Phil's phone. Details go through the
 * redacting logger like everything else, so never put call content in them.
 */
export function raiseAlert(alert: AlertName, details: Record<string, unknown> = {}): void {
  logger.error(`ALERT ${alert}`, { alert, ...details });
}

export type AlertFn = typeof raiseAlert;
