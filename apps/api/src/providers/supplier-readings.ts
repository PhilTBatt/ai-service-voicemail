// What the suppliers themselves say we used, for the Admin page's costs (BUILD_PLAN Step 10):
// Twilio's own usage records and Postmark's own count of emails sent. Read-only, and only for
// the admin's eyes. Our estimates come from our own records (db/cross-tenant.ts); these are the
// check on them, and catch what we don't record (alert emails, say).
//
// Each is behind an interface with a fake (supplier-readings.fake.ts), as every outside service is.

/** A span of whole days, both ends included, YYYY-MM-DD. */
export interface DayRange {
  from: string;
  to: string;
}

/** One kind of Twilio usage, priced. */
export interface TwilioUsageLine {
  /** Twilio's category name ("calls-inbound-local"). */
  category: string;
  /** Twilio's own words for it. */
  description: string;
  pence: number;
  /** How much, as Twilio counts it ("43 minutes"). */
  usage: string;
}

export interface TwilioUsageReading {
  /** Twilio's "totalprice": everything the account used in the range. */
  totalPence: number;
  /** The kinds of use we know, each priced; the rest is in the total but not listed. */
  lines: TwilioUsageLine[];
}

export interface TwilioUsageProvider {
  usage(range: DayRange): Promise<TwilioUsageReading>;
}

/** Postmark's count of what our server sent. */
export interface EmailStatsReading {
  sent: number;
  bounced: number;
  spamComplaints: number;
}

export interface EmailStatsProvider {
  outbound(range: DayRange): Promise<EmailStatsReading>;
}
