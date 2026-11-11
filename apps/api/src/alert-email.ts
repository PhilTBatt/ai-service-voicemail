// Alerts by email (BUILD_PLAN Step 8: "alerts reach Phil's phone"; Phil chose email, decision
// in PROGRESS 2026-11-10). Every alert still goes to the log; this also emails ALERT_EMAIL,
// at most once per alert per 15 minutes, saying how many more there were. A failure is logged,
// never thrown, and never an alert (that would loop).
//
// A failed send used to start the 15 minutes all the same, and its alert was only counted into
// whatever email came next: for a once-a-month alert about one business (billing-no-mandate),
// none might ever come. Now a failed send starts no window, and its alerts wait, counted, until
// an email carries them. While the provider is failing, nothing is tried on each new alert: a
// timer tries again after 1 minute, then 2, 4, 8 and every 15 at most, one email at a time,
// stopping at the first that fails. So an outage costs one attempt per retry, and once the
// provider is back each waiting alert gets its one email, as the throttle would have allowed.
import { setAlertSink, type AlertName, type AlertSink } from "./alerts.ts";
import type { Config } from "./config.ts";
import { checkOutbound, type OutboundPolicy } from "./core/outbound-allowlist.ts";
import { logger } from "./logger.ts";
import type { EmailProvider } from "./providers/email.ts";
import { PostmarkEmailProvider } from "./providers/postmark.ts";
import { redactField } from "./redact.ts";

export const ALERT_EMAIL_MIN_INTERVAL_MS = 15 * 60_000;

/** The wait after the first failed send; it doubles with each failure in a row, up to the max. */
export const ALERT_EMAIL_RETRY_FIRST_MS = 60_000;
export const ALERT_EMAIL_RETRY_MAX_MS = 15 * 60_000;

export interface AlertEmailOptions {
  email: EmailProvider;
  /** Where alerts go: ALERT_EMAIL. Checked against the outbound allowlist like every send. */
  to: string;
  outbound: OutboundPolicy;
  now?: () => Date;
  minIntervalMs?: number;
}

/**
 * Alerts about one business needing something done: throttled per business, not per alert, so
 * two businesses in the same 15 minutes (the 06:00 billing run finds two without a Direct
 * Debit, say) each get their email. Before, the second was only counted into a later email
 * that, for a once-a-month alert, never came. Outage-type alerts stay one per alert name, so a
 * provider down for fifty businesses is one email, not fifty.
 */
const PER_BUSINESS: ReadonlySet<AlertName> = new Set<AlertName>([
  "notification-no-mobile",
  "notification-no-email",
  "notification-refused",
  "recipient-opted-out",
  "email-bounced",
  "email-spam-complaint",
  "number-bought-not-recorded",
  "deletion-confirmation-not-sent",
  "payment-mandate-ended",
  "billing-no-mandate",
  "billing-payment-failed",
]);

function throttleKey(alert: AlertName, details: Record<string, unknown>): string {
  const tenantId = details["tenantId"];
  return PER_BUSINESS.has(alert) && typeof tenantId === "string" ? `${alert}:${tenantId}` : alert;
}

interface RaisedAlert {
  alert: AlertName;
  details: Record<string, unknown>;
  at: Date;
}

/** One throttle window: an alert name, or an alert name and a business. */
interface Window {
  /** When its last email went (or the allowlist turned it away): the window runs from here. */
  sentAt: number | undefined;
  /** Alerts no email has carried yet, the newest among them. */
  unsent: number;
  /** The newest of those, which the next email shows. */
  newest: RaisedAlert | undefined;
  /** An email for it is on its way: a second mustn't start alongside. */
  sending: boolean;
}

/** The sink: one email per alert (per business, for some) per interval, the rest counted. */
export function alertEmailer({
  email,
  to,
  outbound,
  now = () => new Date(),
  minIntervalMs = ALERT_EMAIL_MIN_INTERVAL_MS,
}: AlertEmailOptions): AlertSink {
  // In the order first raised: a retry tries the longest-waiting first.
  const windows = new Map<string, Window>();
  // Sends failed in a row, and while any have, when the next may be tried and the timer for it.
  let failures = 0;
  let retryAt: number | undefined;
  let retryTimer: NodeJS.Timeout | undefined;

  const backingOff = () => retryAt !== undefined && now().getTime() < retryAt;

  const scheduleRetry = () => {
    const delay = Math.min(
      ALERT_EMAIL_RETRY_FIRST_MS * 2 ** (failures - 1),
      ALERT_EMAIL_RETRY_MAX_MS,
    );
    retryAt = now().getTime() + delay;
    clearTimeout(retryTimer);
    // Without it, a waiting alert would only go when another alert came along. Unref'd, so it
    // never holds up a shutdown; an alert still waiting then is in the log, as every alert is.
    // The timer, not the clock, ends the wait: a clock set back mustn't leave alerts stuck.
    retryTimer = setTimeout(() => {
      retryAt = undefined;
      retry().catch((error: unknown) => {
        logger.error("Alert email retry failed", { error });
      });
    }, delay);
    retryTimer.unref();
  };

  /** Tries each window with alerts waiting, stopping at the first failure (which reschedules). */
  const retry = async () => {
    for (const [key, window] of [...windows]) {
      if (backingOff()) return;
      await attempt(key, window);
    }
  };

  const attempt = async (key: string, window: Window) => {
    const newest = window.newest;
    if (!newest || window.sending || backingOff()) return;
    if (window.sentAt !== undefined && now().getTime() - window.sentAt < minIntervalMs) return;

    const decision = checkOutbound(outbound, to);
    if (!decision.allowed) {
      // Refused for as long as the settings stand: no point trying again, so it counts as done.
      logger.warn("Alert email not sent", { alert: newest.alert, reason: decision.reason });
      Object.assign(window, { sentAt: now().getTime(), unsent: 0, newest: undefined });
      return;
    }
    const carried = window.unsent;
    let message;
    try {
      message = alertMessage({ ...newest, suppressed: carried - 1, to });
    } catch (error) {
      // Details that can't be written out (a BigInt, say) would fail every retry: this alert
      // goes no further than the log, and any held with it count into the next email.
      logger.error("Alert email failed", { alert: newest.alert, error });
      window.unsent -= 1;
      window.newest = undefined;
      return;
    }

    window.sending = true;
    try {
      await email.send(message);
    } catch (error) {
      logger.error("Alert email failed", { alert: newest.alert, error });
      failures += 1;
      // To the back of the queue, so one alert the provider won't take can't hold up the rest.
      windows.delete(key);
      windows.set(key, window);
      scheduleRetry();
      return;
    } finally {
      window.sending = false;
    }
    failures = 0;
    retryAt = undefined;
    clearTimeout(retryTimer);
    window.sentAt = now().getTime();
    // Alerts raised while it was on its way stay waiting, for the next window.
    window.unsent -= carried;
    if (window.newest === newest) window.newest = undefined;
  };

  return async (alert, details) => {
    const key = throttleKey(alert, details);
    const window = windows.get(key) ?? {
      sentAt: undefined,
      unsent: 0,
      newest: undefined,
      sending: false,
    };
    windows.set(key, window);
    window.unsent += 1;
    window.newest = { alert, details, at: now() };
    await attempt(key, window);
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
