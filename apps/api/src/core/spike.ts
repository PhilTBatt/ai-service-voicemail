// Spots a burst of something that's fine once and a problem often: fallback voicemails,
// refused webhook signatures, server errors (BUILD_PLAN Step 8's alerts). One counter per
// process: the API runs one or two copies, so a count is per copy, which is close enough for
// "something's wrong" and keeps the hot path off the database.

/** The window every spike alert is measured over. */
export const SPIKE_WINDOW_MS = 15 * 60_000;

/** The plan's own threshold: "more than 2 fallback voicemails in 15 minutes". */
export const FALLBACK_VOICEMAILS_PER_WINDOW = 2;
/** Signatures fail now and then (a retry of an old request, a scanner); a run of them is a forger or a changed key. */
export const SIGNATURE_FAILURES_PER_WINDOW = 10;
/** A 500 is always a bug or an outage; a handful in a window is a trend, not a blip. */
export const SERVER_ERRORS_PER_WINDOW = 5;

export class Spike {
  private readonly times: number[] = [];
  private alertedAt: number | null = null;
  private readonly options: { limit: number; windowMs?: number };

  constructor(options: { limit: number; windowMs?: number }) {
    this.options = options;
  }

  /**
   * Records one event. True exactly when this event takes the window past the limit, and not
   * again until a whole window has passed since the last alert: one email per burst.
   */
  record(at: Date): boolean {
    const windowMs = this.options.windowMs ?? SPIKE_WINDOW_MS;
    const now = at.getTime();
    this.times.push(now);
    while (this.times.length > 0 && this.times[0]! <= now - windowMs) this.times.shift();
    if (this.times.length <= this.options.limit) return false;
    if (this.alertedAt !== null && now - this.alertedAt < windowMs) return false;
    this.alertedAt = now;
    return true;
  }

  /** How many events the window holds, as of the last record(). */
  get count(): number {
    return this.times.length;
  }
}
