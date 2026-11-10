// Alerts by email (BUILD_PLAN Step 8: "alerts reach Phil's phone"; Phil chose email, decision
// in PROGRESS 2026-11-10). Every alert still goes to the log; this also emails ALERT_EMAIL,
// at most once per alert per 15 minutes, saying how many more there were. Sending is best
// effort: a failure is logged, never thrown, and never an alert (that would loop).
import { setAlertSink, type AlertName, type AlertSink } from "./alerts.ts";
import type { Config } from "./config.ts";
import { checkOutbound, type OutboundPolicy } from "./core/outbound-allowlist.ts";
import { logger } from "./logger.ts";
import type { EmailProvider } from "./providers/email.ts";
import { PostmarkEmailProvider } from "./providers/postmark.ts";
import { redactField } from "./redact.ts";

export const ALERT_EMAIL_MIN_INTERVAL_MS = 15 * 60_000;

export interface AlertEmailOptions {
  email: EmailProvider;
  /** Where alerts go: ALERT_EMAIL. Checked against the outbound allowlist like every send. */
  to: string;
  outbound: OutboundPolicy;
  now?: () => Date;
  minIntervalMs?: number;
}

/** The sink: one email per alert name per interval, the rest counted into the next one. */
export function alertEmailer({
  email,
  to,
  outbound,
  now = () => new Date(),
  minIntervalMs = ALERT_EMAIL_MIN_INTERVAL_MS,
}: AlertEmailOptions): AlertSink {
  const lastSent = new Map<AlertName, { at: number; suppressed: number }>();

  return async (alert, details) => {
    const at = now();
    const last = lastSent.get(alert);
    if (last && at.getTime() - last.at < minIntervalMs) {
      last.suppressed += 1;
      return;
    }
    const suppressed = last?.suppressed ?? 0;
    lastSent.set(alert, { at: at.getTime(), suppressed: 0 });

    const decision = checkOutbound(outbound, to);
    if (!decision.allowed) {
      logger.warn("Alert email not sent", { alert, reason: decision.reason });
      return;
    }
    try {
      await email.send(alertMessage({ alert, details, at, suppressed, to }));
    } catch (error) {
      logger.error("Alert email failed", { alert, error });
    }
  };
}

/** Installs the email sink when ALERT_EMAIL and the email settings are there; says if not. */
export function installAlertEmail(
  config: Pick<Config, "email" | "alertEmail" | "outbound">,
): boolean {
  if (!config.email || !config.alertEmail) {
    logger.warn("Alert emails off: needs ALERT_EMAIL, POSTMARK_SERVER_TOKEN and EMAIL_FROM");
    return false;
  }
  setAlertSink(
    alertEmailer({
      email: new PostmarkEmailProvider(config.email),
      to: config.alertEmail,
      outbound: config.outbound,
    }),
  );
  logger.info("Alert emails on");
  return true;
}

const ukTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  dateStyle: "medium",
  timeStyle: "short",
});

/** The email: redacted details, the time in UK terms, and where the runbook explains it. */
export function alertMessage(alert: {
  alert: AlertName;
  details: Record<string, unknown>;
  at: Date;
  suppressed: number;
  to: string;
}) {
  const details = Object.fromEntries(
    Object.entries(alert.details).map(([key, value]) => [
      key,
      redactField(key, value instanceof Error ? `${value.name}: ${value.message}` : value),
    ]),
  );
  const lines = [
    `AnswerMate alert: ${alert.alert}`,
    `At: ${ukTime.format(alert.at)} (UK time)`,
    ...(alert.suppressed > 0
      ? [`Plus ${alert.suppressed} more of these since the last email about it.`]
      : []),
    "",
    "Details:",
    JSON.stringify(details, null, 2),
    "",
    "What it means and what to check: docs/RUNBOOK.md, section 11.",
  ];
  const text = lines.join("\n");
  return {
    to: alert.to,
    subject: `[AnswerMate] ${alert.alert}${alert.suppressed > 0 ? ` (+${alert.suppressed})` : ""}`,
    text,
    html: `<pre style="font: 14px/1.4 monospace">${escapeHtml(text)}</pre>`,
  };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
