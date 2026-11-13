// Twilio's and Postmark's own figures for the admin's costs (routes/admin.ts): read beside our
// estimates, each on its own, so one supplier being slow or down never stops the page. A
// supplier not set up on this server says so; one that fails says how, with nothing secret.
import type { AccountReadingsView } from "@callmate/shared";
import type { SupplierAccounts } from "../core/service-costs.ts";
import type { readServiceUsage } from "../db/cross-tenant.ts";
import { logger } from "../logger.ts";
import type { DayRange, EmailStatsReading } from "../providers/supplier-readings.ts";
import type { SupplierReadingProviders } from "./admin.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

const utcDate = (at: number) => new Date(at).toISOString().slice(0, 10);

/** The last 30 days, today included, and the 30 before: whole days, as both APIs count. */
export function accountRanges(now: Date): { last: DayRange; previous: DayRange } {
  const today = now.getTime();
  return {
    last: { from: utcDate(today - 29 * DAY_MS), to: utcDate(today) },
    previous: { from: utcDate(today - 59 * DAY_MS), to: utcDate(today - 30 * DAY_MS) },
  };
}

/** Why a reading failed, in words safe to show and log: the kind of error and any HTTP status. */
function failure(error: unknown): string {
  if (error instanceof Error) {
    const status = (error as { status?: unknown }).status;
    if (error.name === "TimeoutError") return "It didn't answer within 8 seconds";
    return typeof status === "number" ? `It answered HTTP ${status}` : error.message.slice(0, 120);
  }
  return "Unknown error";
}

export async function readSupplierAccounts(
  providers: SupplierReadingProviders,
  now: Date,
  usage: Awaited<ReturnType<typeof readServiceUsage>>,
): Promise<{ view: AccountReadingsView; forCosts: SupplierAccounts }> {
  const ranges = accountRanges(now);
  const twilioEstimate =
    usage.last.pence.phoneMinutes +
    usage.last.pence.transcription +
    usage.last.pence.texts +
    usage.last.pence.numbers;

  const [twilio, postmark] = await Promise.all([
    providers.twilio
      ? providers.twilio.usage(ranges.last).then(
          (reading) => ({ ok: true as const, reading }),
          (error: unknown) => ({ ok: false as const, reason: failure(error) }),
        )
      : null,
    providers.email
      ? Promise.all([
          providers.email.outbound(ranges.last),
          providers.email.outbound(ranges.previous),
        ]).then(
          ([last, previous]: [EmailStatsReading, EmailStatsReading]) => ({
            ok: true as const,
            last,
            previous,
          }),
          (error: unknown) => ({ ok: false as const, reason: failure(error) }),
        )
      : null,
  ]);
  if (twilio && !twilio.ok) logger.warn("Couldn't read Twilio's usage", { reason: twilio.reason });
  if (postmark && !postmark.ok)
    logger.warn("Couldn't read Postmark's stats", { reason: postmark.reason });

  return {
    view: {
      from: ranges.last.from,
      to: ranges.last.to,
      twilio:
        twilio === null
          ? { status: "off", reason: "Twilio isn't set up on this server" }
          : twilio.ok
            ? {
                status: "read",
                totalPence: twilio.reading.totalPence,
                estimatePence: twilioEstimate,
                lines: twilio.reading.lines,
              }
            : { status: "failed", reason: twilio.reason },
      postmark:
        postmark === null
          ? { status: "off", reason: "Postmark isn't set up on this server" }
          : postmark.ok
            ? {
                status: "read",
                sent: postmark.last.sent,
                previousSent: postmark.previous.sent,
                ourCount: usage.last.emails,
                bounced: postmark.last.bounced,
                spamComplaints: postmark.last.spamComplaints,
              }
            : { status: "failed", reason: postmark.reason },
    },
    forCosts: {
      twilioPence: twilio?.ok ? twilio.reading.totalPence : null,
      postmark: postmark?.ok ? { last: postmark.last, previous: postmark.previous } : null,
    },
  };
}
