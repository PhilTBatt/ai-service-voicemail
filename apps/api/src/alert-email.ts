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
//
// Those waiting alerts were only in memory, so a restart or a release lost them (2026-11-13).
// Now, given the database, every alert is written to the outbox (db/alert-outbox.ts) before
// it's emailed, and each process sweeps the outbox every minute, starting the moment it starts:
// a waiting alert outlives the process that raised it. The throttle and the back-off live in
// the outbox too, so they hold across the API and the worker, and alerts the throttle held back
// now get their email when the 15 minutes are up ("Plus 3 more..."), not only when another
// comes. If the database can't be reached (one of the things an alert can be about), the alert
// goes through the in-memory sender above instead, as every alert did before.
import type pg from "pg";
import { setAlertSink, type AlertName, type AlertSink } from "./alerts.ts";
import type { Config } from "./config.ts";
import { checkOutbound, type OutboundPolicy } from "./core/outbound-allowlist.ts";
import { logger } from "./logger.ts";
import type { EmailProvider } from "./providers/email.ts";
import { PostmarkEmailProvider } from "./providers/postmark.ts";
import {
  claimDueAlerts,
  markAlertFailed,
  markAlertSent,
  pruneSentAlerts,
  recordAlert,
} from "./db/alert-outbox.ts";
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
  // A failed delivery of one of the business's own messages (an onboarding text, a billing
  // email: db/delivery-receipts.ts names it in messageKind) is about that business, whatever
  // the alert: a carrier's trouble with call texts across many businesses, which sms-undelivered
  // otherwise means, mustn't hide it inside one email.
  const perBusiness = PER_BUSINESS.has(alert) || typeof details["messageKind"] === "string";
  return perBusiness && typeof tenantId === "string" ? `${alert}:${tenantId}` : alert;
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

/** How often each process looks through the outbox for alerts due an email. */
export const ALERT_SWEEP_MS = 60_000;

export interface DurableAlertEmailOptions extends AlertEmailOptions {
  /** The app role's pool: the outbox has no tenant data, so no tenant context. */
  pool: pg.Pool;
  /** Where an alert goes when the outbox can't be written: the in-memory sender. */
  fallback: AlertSink;
}

/**
 * The sink that keeps alerts in the database until an email carries them, and the sweep that
 * sends whatever is due (each process runs it every minute, and once as it starts).
 */
export function durableAlertEmailer({
  pool,
  email,
  to,
  outbound,
  fallback,
  now = () => new Date(),
  minIntervalMs = ALERT_EMAIL_MIN_INTERVAL_MS,
}: DurableAlertEmailOptions): { sink: AlertSink; sweep: () => Promise<void> } {
  /** Emails each window claimed (one, or every one due), recording what became of it. */
  const deliver = async (key?: string) => {
    const claimed = await claimDueAlerts(pool, {
      at: now(),
      minIntervalMs,
      ...(key !== undefined && { key }),
    });
    for (const [index, alert] of claimed.entries()) {
      const decision = checkOutbound(outbound, to);
      if (!decision.allowed) {
        // Refused for as long as the settings stand: no point trying again, so it counts as done.
        logger.warn("Alert email not sent", { alert: alert.alert, reason: decision.reason });
        await markAlertSent(pool, { key: alert.key, carried: alert.unsent, at: now() });
        continue;
      }
      try {
        await email.send(
          composeAlertMessage({
            alert: alert.alert,
            details: alert.details,
            at: alert.raisedAt,
            suppressed: alert.unsent - 1,
            to,
          }),
        );
      } catch (error) {
        logger.error("Alert email failed", { alert: alert.alert, error });
        await markAlertFailed(pool, { key: alert.key, at: now() });
        // The provider is failing: the rest wait for their own retry rather than each trying
        // now. Their claims lapse in two minutes; letting them go now is tidier.
        for (const rest of claimed.slice(index + 1)) {
          await markAlertFailed(pool, { key: rest.key, at: now() });
        }
        return;
      }
      await markAlertSent(pool, { key: alert.key, carried: alert.unsent, at: now() });
    }
  };

  const sink: AlertSink = async (alert, details) => {
    const key = throttleKey(alert, details);
    let stored: Record<string, unknown>;
    try {
      stored = redactedDetails(details);
    } catch (error) {
      // Details that can't be written out (a BigInt, say): this alert goes no further than the
      // log, as before.
      logger.error("Alert email failed", { alert, error });
      return;
    }
    try {
      await recordAlert(pool, { key, alert, details: stored, at: now() });
    } catch (error) {
      logger.warn("Alert outbox unreachable: this alert's email waits in memory", {
        alert,
        error,
      });
      await fallback(alert, details);
      return;
    }
    try {
      await deliver(key);
    } catch (error) {
      // Saved, so the next sweep sends it.
      logger.error("Alert email failed", { alert, error });
    }
  };

  const sweep = async () => {
    await deliver();
    await pruneSentAlerts(pool, now());
  };
  return { sink, sweep };
}

let sweepTimer: NodeJS.Timeout | undefined;

/** Stops the outbox sweep (at shutdown, before the pool closes). */
export function stopAlertEmail(): void {
  clearInterval(sweepTimer);
  sweepTimer = undefined;
}

/**
 * Installs the email sink when ALERT_EMAIL and the email settings are there; says if not.
 * Given the database, alerts wait in the outbox and survive a restart, and the sweep starts;
 * without, they wait in memory as before.
 */
export function installAlertEmail(
  config: Pick<Config, "email" | "alertEmail" | "outbound">,
  pool?: pg.Pool,
): boolean {
  if (!config.email || !config.alertEmail) {
    logger.warn("Alert emails off: needs ALERT_EMAIL, POSTMARK_SERVER_TOKEN and EMAIL_FROM");
    return false;
  }
  const options = {
    email: new PostmarkEmailProvider(config.email),
    to: config.alertEmail,
    outbound: config.outbound,
  };
  const memory = alertEmailer(options);
  if (!pool) {
    setAlertSink(memory);
    logger.info("Alert emails on");
    return true;
  }
  const { sink, sweep } = durableAlertEmailer({ ...options, pool, fallback: memory });
  setAlertSink(sink);
  const run = () => {
    sweep().catch((error: unknown) => {
      logger.warn("Alert outbox sweep failed; the next minute's tries again", { error });
    });
  };
  // Straight away, for alerts a restart left waiting; then every minute. Unref'd, so it never
  // holds up a shutdown.
  stopAlertEmail();
  run();
  sweepTimer = setInterval(run, ALERT_SWEEP_MS);
  sweepTimer.unref();
  logger.info("Alert emails on, through the outbox");
  return true;
}

const ukTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  dateStyle: "medium",
  timeStyle: "short",
});

/**
 * An alert's details as its email shows them: redacted, errors as their name and message, and
 * written out as JSON and back, so what's stored is what's sent. Throws for details JSON can't
 * hold (a BigInt).
 */
export function redactedDetails(details: Record<string, unknown>): Record<string, unknown> {
  const redacted = Object.fromEntries(
    Object.entries(details).map(([key, value]) => [
      key,
      redactField(key, value instanceof Error ? `${value.name}: ${value.message}` : value),
    ]),
  );
  return JSON.parse(JSON.stringify(redacted)) as Record<string, unknown>;
}

/** The email: redacted details, the time in UK terms, and where the runbook explains it. */
export function alertMessage(alert: {
  alert: AlertName;
  details: Record<string, unknown>;
  at: Date;
  suppressed: number;
  to: string;
}) {
  return composeAlertMessage({ ...alert, details: redactedDetails(alert.details) });
}

/** The email from details already redacted (from the outbox, say). */
export function composeAlertMessage(alert: {
  alert: string;
  details: Record<string, unknown>;
  at: Date;
  suppressed: number;
  to: string;
}) {
  const details = alert.details;
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
