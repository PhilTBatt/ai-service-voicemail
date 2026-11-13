// Stand-ins for Twilio's usage records and Postmark's stats: the tests and the browser tests
// set what they say, or make them fail, and see what was asked.
import type {
  DayRange,
  EmailStatsProvider,
  EmailStatsReading,
  TwilioUsageProvider,
  TwilioUsageReading,
} from "./supplier-readings.ts";

export class FakeTwilioUsage implements TwilioUsageProvider {
  readonly asked: DayRange[] = [];
  reading: TwilioUsageReading = { totalPence: 0, lines: [] };
  failure: Error | null = null;

  usage(range: DayRange): Promise<TwilioUsageReading> {
    this.asked.push(range);
    return this.failure ? Promise.reject(this.failure) : Promise.resolve(this.reading);
  }
}

export class FakeEmailStats implements EmailStatsProvider {
  readonly asked: DayRange[] = [];
  /** By the range's first day; any other range reads as nothing sent. */
  readings = new Map<string, EmailStatsReading>();
  failure: Error | null = null;

  outbound(range: DayRange): Promise<EmailStatsReading> {
    this.asked.push(range);
    if (this.failure) return Promise.reject(this.failure);
    return Promise.resolve(
      this.readings.get(range.from) ?? { sent: 0, bounced: 0, spamComplaints: 0 },
    );
  }
}
