// Postmark's Stats API: how many emails our server sent, bounced or drew complaints.
//
// From Postmark's docs (https://postmarkapp.com/developer/api/stats-api, read 2026-11-13):
// GET https://api.postmarkapp.com/stats/outbound with the X-Postmark-Server-Token header;
// `fromdate` and `todate` are both inclusive; without `messagestream` it covers "all streams in
// the server"; "All stats use EST timezone". The answer has `Sent`, `Bounced` and
// `SpamComplaints`, among others. It counts one server, not the whole account: the free plan's
// 100 is the account's, the same thing while there's one server.
import { z } from "zod";
import type { DayRange, EmailStatsProvider, EmailStatsReading } from "./supplier-readings.ts";

const statsSchema = z.object({
  Sent: z.number().int().nonnegative(),
  Bounced: z.number().int().nonnegative(),
  SpamComplaints: z.number().int().nonnegative(),
});

export class PostmarkApiError extends Error {
  override readonly name = "PostmarkApiError";
  readonly status: number;

  constructor(status: number, body: string) {
    super(`Postmark answered ${status}: ${body}`);
    this.status = status;
  }
}

export interface PostmarkStatsOptions {
  serverToken: string;
  /** Injected by tests. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class PostmarkStatsApi implements EmailStatsProvider {
  private readonly options: PostmarkStatsOptions;

  constructor(options: PostmarkStatsOptions) {
    this.options = options;
  }

  async outbound({ from, to }: DayRange): Promise<EmailStatsReading> {
    const query = new URLSearchParams({ fromdate: from, todate: to });
    const response = await (this.options.fetch ?? fetch)(
      `https://api.postmarkapp.com/stats/outbound?${query}`,
      {
        headers: {
          Accept: "application/json",
          "X-Postmark-Server-Token": this.options.serverToken,
        },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 8_000),
      },
    );
    if (!response.ok) {
      throw new PostmarkApiError(response.status, (await response.text()).slice(0, 300));
    }
    const parsed = statsSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Postmark's stats weren't in the documented shape");
    return {
      sent: parsed.data.Sent,
      bounced: parsed.data.Bounced,
      spamComplaints: parsed.data.SpamComplaints,
    };
  }
}
