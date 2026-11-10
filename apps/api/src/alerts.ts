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
  "notification-refused",
  "sms-undelivered",
  "recipient-opted-out",
  "email-bounced",
  "email-spam-complaint",
  "number-bought-not-recorded",
  "deletion-confirmation-not-sent",
  "fallback-voicemail-spike",
  "webhook-signature-spike",
  "server-error-spike",
] as const;

export type AlertName = (typeof ALERTS)[number];

/** Where alerts go besides the log: Step 8 installs the email sender (alert-email.ts). */
export type AlertSink = (alert: AlertName, details: Record<string, unknown>) => Promise<void>;

let sink: AlertSink | undefined;

/** Sets (or, with undefined, removes) the sink every alert is also handed to. */
export function setAlertSink(next: AlertSink | undefined): void {
  sink = next;
}

/**
 * Something a person needs to see soon. Always an error-level log line carrying an `alert`
 * field; with the email sender installed, an email to ALERT_EMAIL too. Details go through
 * the redacting logger like everything else, so never put call content in them.
 */
export function raiseAlert(alert: AlertName, details: Record<string, unknown> = {}): void {
  logger.error(`ALERT ${alert}`, { alert, ...details });
  // The sink handles its own failures; this only makes sure one can't take the caller down.
  if (sink) {
    void sink(alert, details).catch((error: unknown) => {
      logger.error("Alert sink failed", { alert, error });
    });
  }
}

export type AlertFn = typeof raiseAlert;
