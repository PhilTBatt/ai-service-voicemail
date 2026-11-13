// Every supplier the service runs on, as the Admin page's Costs tab shows it: what plan we're
// on, its tiers, what the last 30 days cost, where the next 30 are heading, and a warning when
// that crosses a tier (up or down). Pure: db/cross-tenant.ts reads the usage, this prices it.
// Integer pence throughout; every figure is an estimate from our own records and each
// supplier's published prices, never a bill.
//
// Prices read 2026-11-13 unless a line says otherwise:
//   Retell      https://www.retellai.com/pricing
//   Twilio      https://www.twilio.com/en-us/voice/pricing/gb, /sms/pricing/gb (no volume tiers)
//   Anthropic   https://platform.claude.com/docs/en/api/rate-limits (monthly spend caps)
//   Postmark    https://postmarkapp.com/pricing; the 50,000 and 125,000 steps from the account's
//               own Plans page (Phil's screenshot, 2026-11-13): the public page lists only 10,000
//   GoCardless  https://gocardless.com/pricing/
//   Clerk       https://clerk.com/pricing
//   UptimeRobot https://uptimerobot.com/pricing/
//   Azure       decision 011 (Azure's price API, 2026-11-07) and
//               https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/concepts-limits
import type { ServiceCostView, ServiceCostsView, ServiceTierView } from "@callmate/shared";

/** How many days each window is: the last 30, and the 30 before them. */
export const SERVICE_WINDOW_DAYS = 30;

/** A share of a limit from which the page warns: 80%. */
export const NEAR_LIMIT = 0.8;

/** What was used in one window of SERVICE_WINDOW_DAYS days. */
export interface WindowUsage {
  calls: number;
  /** Call length added up, in seconds. */
  callSeconds: number;
  /** The most calls the assistant was on at once. */
  peakConcurrentCalls: number;
  /** Emails we recorded sending (call emails, receipts, cancellation notices). */
  emails: number;
  /** Text segments, call texts and account texts together. */
  textSegments: number;
  /** Estimated cost of each metered part, whole pence (estimateCosts). */
  pence: {
    voicePlatform: number;
    languageModel: number;
    texts: number;
    phoneMinutes: number;
    numbers: number;
    transcription: number;
  };
  /** Each Direct Debit payment asked for in the window, in pence. */
  payments: number[];
}

export interface ServiceReadings {
  last: WindowUsage;
  previous: WindowUsage;
  /** Businesses that pay: live at some point, not the demo line or a test. */
  payingBusinesses: number;
  /** Numbers rented now. */
  activeNumbers: number;
  /** People with a dashboard login. */
  logins: number;
  /** What the paying businesses' current billing months come to so far, before VAT. */
  incomePence: number;
  /**
   * What the suppliers' own accounts say, where they could be read: the truth our estimates
   * are checked against, and used in their place.
   */
  accounts?: SupplierAccounts | undefined;
}

/** The suppliers' own figures for the same two windows. Null where one couldn't be read. */
export interface SupplierAccounts {
  /** Twilio's own total for the last window, in pence. */
  twilioPence: number | null;
  /** Postmark's own counts, alert emails and everything else our server sent included. */
  postmark: { last: EmailCounts; previous: EmailCounts } | null;
}

export interface EmailCounts {
  sent: number;
  bounced: number;
  spamComplaints: number;
}

/**
 * Postmark pauses an account whose bounces pass 10% of its emails, or whose spam complaints
 * pass 1 in 1,000 (RUNBOOK section 16). The page warns at half of each.
 */
export const POSTMARK_BOUNCE_LIMIT_PERCENT = 10;
export const POSTMARK_COMPLAINT_LIMIT_PERCENT = 0.1;

/** The plans we're on. Change one here when Phil changes it at the supplier. */
export const CURRENT_PLANS = {
  postmark: "free",
  clerk: "hobby",
  database: "b1ms",
  uptime: "free",
} as const;

/** Pounds per dollar and per euro for prices listed in them: on the high side, as core/prices.ts. */
const GBP_PER_USD = 0.8;
const GBP_PER_EUR = 0.9;
const usd = (dollars: number) => Math.round(dollars * GBP_PER_USD * 100);

export const RETELL = { freeConcurrentCalls: 20, extraConcurrentCallPence: usd(8) };
/** Anthropic's monthly spend caps by usage tier. Which tier the account is on isn't in its docs. */
export const ANTHROPIC_SPEND_CAPS = [
  { name: "Start", capPence: usd(500) },
  { name: "Build", capPence: usd(1000) },
  { name: "Scale", capPence: usd(200_000) },
];
export const POSTMARK_TIERS = [
  { id: "free", name: "Free", emails: 100, pence: 0 },
  { id: "10k", name: "Basic 10,000", emails: 10_000, pence: usd(15) },
  { id: "50k", name: "Basic 50,000", emails: 50_000, pence: usd(55) },
  { id: "125k", name: "Basic 125,000", emails: 125_000, pence: usd(115) },
];
/** Basic's price for each 1,000 emails over the plan. The free plan allows none: emails stop. */
export const POSTMARK_EXTRA_PER_1000_PENCE = usd(1.8);
export const GOCARDLESS = { percent: 1, fixedPence: 20, capPence: 400 };
export const CLERK = { freeUsers: 50_000, proPence: usd(25) };
export const DATABASE_TIERS = [
  { id: "b1ms", name: "B1ms (1 core, 2 GB)", pence: 1044, connections: 35 },
  { id: "b2s", name: "B2s (2 cores, 4 GB)", pence: 4170, connections: 414 },
];
/** The database connections the apps and a task open at a release's peak (RUNBOOK section 16). */
export const DATABASE_CONNECTIONS_USED = 35;
/** Decision 011's production estimate without the database server: storage, registry, logs, apps idle. */
export const AZURE_OTHER_PENCE = 3300 - 1044;
export const UPTIME = {
  freeMonitors: 50,
  monitorsUsed: 2,
  soloPence: Math.round(13 * GBP_PER_EUR * 100),
};
/** brockersby.co.uk at Porkbun: $5.66 a year. */
export const DOMAIN_PENCE_PER_MONTH = Math.round(usd(5.66) / 12);

export interface Trend {
  last: number;
  previous: number;
  /** A straight line through the two windows, never below zero. */
  next: number;
  /** The change from the window before, in percent; null when that window had none. */
  ratePercent: number | null;
}

/** Where a count is heading: last window, the one before, and the same step again. */
export function trend(last: number, previous: number): Trend {
  return {
    last,
    previous,
    next: Math.max(0, last + (last - previous)),
    ratePercent: previous === 0 ? null : Math.round(((last - previous) / previous) * 100),
  };
}

/** A metered cost scaled to where its driver is heading. With no driver yet, it stays as it is. */
export function scaled(pence: number, driver: Trend): number {
  return driver.last === 0 ? pence : Math.round((pence * driver.next) / driver.last);
}

/** GoCardless's fee on one payment: 1% plus 20p, capped at £4 (UK Standard plan). */
export function goCardlessFeePence(paymentPence: number): number {
  if (paymentPence <= 0) return 0;
  return Math.min(
    GOCARDLESS.capPence,
    Math.round((paymentPence * GOCARDLESS.percent) / 100) + GOCARDLESS.fixedPence,
  );
}

/** What a month of `emails` costs on a Postmark tier; null when the tier can't send that many. */
export function postmarkPence(tierId: string, emails: number): number | null {
  const tier = POSTMARK_TIERS.find((each) => each.id === tierId);
  if (!tier) throw new Error(`Unknown Postmark tier ${tierId}`);
  if (emails <= tier.emails) return tier.pence;
  if (tier.pence === 0) return null;
  return tier.pence + Math.ceil((emails - tier.emails) / 1000) * POSTMARK_EXTRA_PER_1000_PENCE;
}

/** The cheapest Postmark tier for a month of `emails`, extra emails counted. */
export function cheapestPostmarkTier(emails: number): { id: string; name: string; pence: number } {
  let best: { id: string; name: string; pence: number } | null = null;
  for (const tier of POSTMARK_TIERS) {
    const pence = postmarkPence(tier.id, emails);
    if (pence !== null && (best === null || pence < best.pence)) {
      best = { id: tier.id, name: tier.name, pence };
    }
  }
  // The largest tier takes any number, with extras, so there's always one.
  return best!;
}

type Warning = ServiceCostView["warnings"][number];

const pounds = (pence: number) => `£${(pence / 100).toFixed(2)}`;

function tiers<T extends { name: string }>(
  all: readonly T[],
  current: T | undefined,
  detail: (tier: T) => Omit<ServiceTierView, "name" | "current">,
): ServiceTierView[] {
  return all.map((tier) => ({ name: tier.name, current: tier === current, ...detail(tier) }));
}

function retell(readings: ServiceReadings, minutes: Trend): ServiceCostView {
  const peak = trend(readings.last.peakConcurrentCalls, readings.previous.peakConcurrentCalls);
  const extra = (calls: number) =>
    Math.max(0, calls - RETELL.freeConcurrentCalls) * RETELL.extraConcurrentCallPence;
  const warnings: Warning[] = [];
  if (peak.last > RETELL.freeConcurrentCalls) {
    warnings.push({
      direction: "up",
      text: `${peak.last} calls at once passed the ${RETELL.freeConcurrentCalls} Retell includes: each extra line is ${pounds(RETELL.extraConcurrentCallPence)} a month, and until it's bought those callers get the voicemail.`,
    });
  } else if (peak.last >= RETELL.freeConcurrentCalls * NEAR_LIMIT) {
    warnings.push({
      direction: "up",
      text: `${peak.last} calls at once is close to the ${RETELL.freeConcurrentCalls} Retell includes. Each extra line is ${pounds(RETELL.extraConcurrentCallPence)} a month.`,
    });
  }
  return {
    id: "retell",
    name: "Retell AI",
    purpose: "The voice assistant that answers each call",
    plan: "Pay as you go",
    pricing: "Per minute of call, as Retell reports it for each call. No monthly fee.",
    usage: {
      label: "Most calls at once",
      used: peak.last,
      limit: RETELL.freeConcurrentCalls,
      unit: "calls",
    },
    tiers: [
      {
        name: `Up to ${RETELL.freeConcurrentCalls} calls at once`,
        current: peak.last <= RETELL.freeConcurrentCalls,
        monthlyPence: 0,
        limit: `${RETELL.freeConcurrentCalls} calls at once`,
      },
      {
        name: "Each extra call at once",
        current: peak.last > RETELL.freeConcurrentCalls,
        monthlyPence: RETELL.extraConcurrentCallPence,
        limit: "Enterprise from 50",
      },
    ],
    pence: {
      now: readings.last.pence.voicePlatform + extra(peak.last),
      next: scaled(readings.last.pence.voicePlatform, minutes) + extra(peak.next),
    },
    measured: false,
    drivenBy: "Call minutes",
    warnings,
  };
}

function twilio(readings: ServiceReadings, minutes: Trend, segments: Trend): ServiceCostView {
  const { pence } = readings.last;
  const metered = pence.phoneMinutes + pence.transcription;
  return {
    id: "twilio",
    name: "Twilio",
    purpose: "Phone numbers, the calls coming in, and texts",
    plan: "Pay as you go",
    pricing: "Per minute, per text segment and per number. Twilio's UK pages list no volume tiers.",
    usage: { label: "Numbers rented", used: readings.activeNumbers, limit: null, unit: "numbers" },
    tiers: [
      { name: "Pay as you go", current: true, monthlyPence: 0, limit: "No volume tiers listed" },
      {
        name: "Committed use",
        current: false,
        monthlyPence: null,
        limit: "A discount agreed with Twilio's sales team",
      },
    ],
    pence: twilioPence(readings, {
      now: metered + pence.texts + pence.numbers,
      next: scaled(metered, minutes) + scaled(pence.texts, segments) + pence.numbers,
    }),
    measured: readings.accounts?.twilioPence != null,
    drivenBy: "Call minutes, texts and numbers",
    warnings: [],
  };
}

/**
 * Twilio's figures: its own total for the last window when it could be read, and where that's
 * heading moved by the same amount our estimate moves.
 */
function twilioPence(
  readings: ServiceReadings,
  estimate: { now: number; next: number },
): { now: number; next: number } {
  const actual = readings.accounts?.twilioPence;
  if (actual == null) return estimate;
  return {
    now: actual,
    next: estimate.now === 0 ? actual : Math.round((actual * estimate.next) / estimate.now),
  };
}

function anthropic(readings: ServiceReadings, calls: Trend): ServiceCostView {
  const now = readings.last.pence.languageModel;
  const next = scaled(now, calls);
  const first = ANTHROPIC_SPEND_CAPS[0]!;
  const warnings: Warning[] = [];
  if (next >= first.capPence * NEAR_LIMIT) {
    warnings.push({
      direction: "up",
      text: `AI summaries are heading for ${pounds(next)} a month, close to the ${pounds(first.capPence)} cap of Anthropic's ${first.name} tier. Check the account's tier in the Claude Console before it's reached: past a cap, summaries stop until the next month.`,
    });
  }
  return {
    id: "anthropic",
    name: "Anthropic (Claude)",
    purpose: "The summary and triage of each call",
    plan: "Pay as you go",
    pricing: "Per token, at the model's list price. Each usage tier has a monthly spend cap.",
    usage: {
      label: "Spend against the first cap",
      used: now,
      limit: first.capPence,
      unit: "pence",
    },
    tiers: ANTHROPIC_SPEND_CAPS.map((tier, index) => ({
      name: `${tier.name} tier`,
      // Which tier the account is on isn't something we can read: the first is the safe one to watch.
      current: index === 0,
      monthlyPence: 0,
      limit: `Up to ${pounds(tier.capPence)} a month`,
    })),
    pence: { now, next },
    measured: false,
    drivenBy: "Calls",
    warnings,
  };
}

function postmark(emails: Trend, counts: EmailCounts | null): ServiceCostView {
  const current = POSTMARK_TIERS.find((tier) => tier.id === CURRENT_PLANS.postmark)!;
  const best = cheapestPostmarkTier(emails.next);
  const now = postmarkPence(current.id, emails.last);
  const next = postmarkPence(current.id, emails.next);
  const warnings: Warning[] = [];
  if (next === null || now === null) {
    warnings.push({
      direction: "up",
      text: `${emails.next} emails a month is over the ${current.emails} the ${current.name} plan allows, and it sends none past that: emails would stop until the month renews. ${best.name} is ${pounds(best.pence)} a month.`,
    });
  } else if (emails.next >= current.emails * NEAR_LIMIT && current.pence === 0) {
    warnings.push({
      direction: "up",
      text: `${emails.next} emails a month is close to the ${current.emails} the ${current.name} plan allows, and it sends none past that. The next plan is ${pounds(POSTMARK_TIERS[1]!.pence)} a month.`,
    });
  } else if (best.pence < next) {
    const cheaper = POSTMARK_TIERS.findIndex((tier) => tier.id === best.id);
    const mine = POSTMARK_TIERS.indexOf(current);
    warnings.push({
      direction: cheaper < mine ? "down" : "up",
      text:
        cheaper < mine
          ? `${emails.next} emails a month fits ${best.name}: ${pounds(best.pence)} a month, down from ${pounds(next)}.`
          : `At ${emails.next} emails a month, ${best.name} is cheaper than paying for extras: ${pounds(best.pence)} against ${pounds(next)}.`,
    });
  }
  if (counts !== null && counts.sent > 0) {
    const bounceRate = (counts.bounced / counts.sent) * 100;
    const complaintRate = (counts.spamComplaints / counts.sent) * 100;
    if (bounceRate >= POSTMARK_BOUNCE_LIMIT_PERCENT / 2) {
      warnings.push({
        direction: "up",
        text: `${counts.bounced} of ${counts.sent} emails bounced (${bounceRate.toFixed(1)}%). Postmark pauses an account past ${POSTMARK_BOUNCE_LIMIT_PERCENT}%: check the addresses on the businesses' Account pages.`,
      });
    }
    if (complaintRate >= POSTMARK_COMPLAINT_LIMIT_PERCENT / 2) {
      warnings.push({
        direction: "up",
        text: `${counts.spamComplaints} of ${counts.sent} emails were reported as spam (${complaintRate.toFixed(2)}%). Postmark pauses an account past 1 in 1,000.`,
      });
    }
  }
  return {
    id: "postmark",
    name: "Postmark",
    purpose: "Emails: call summaries, receipts and alerts",
    plan: current.name,
    pricing: `By emails a month. Paid plans charge ${pounds(POSTMARK_EXTRA_PER_1000_PENCE)} for each extra 1,000; the free plan sends none past its limit.`,
    usage: {
      label: counts === null ? "Emails (our count, without alerts)" : "Emails (Postmark's count)",
      used: emails.last,
      limit: current.emails,
      unit: "emails",
    },
    tiers: tiers(POSTMARK_TIERS, current, (tier) => ({
      monthlyPence: tier.pence,
      limit: `${tier.emails.toLocaleString("en-GB")} emails a month`,
    })),
    // Over the free plan's limit there's nothing to pay: the cost is the emails not sent.
    pence: { now: now ?? current.pence, next: next ?? best.pence },
    measured: counts !== null,
    drivenBy: "Emails sent",
    warnings,
  };
}

function goCardless(readings: ServiceReadings): ServiceCostView {
  const fees = (payments: number[]) =>
    payments.reduce((total, pence) => total + goCardlessFeePence(pence), 0);
  // Next month: every paying business's month so far collected once.
  const typical =
    readings.payingBusinesses === 0
      ? 0
      : Math.round(readings.incomePence / readings.payingBusinesses);
  return {
    id: "gocardless",
    name: "GoCardless",
    purpose: "Collecting each month's payment by Direct Debit",
    plan: "Standard",
    pricing: `${GOCARDLESS.percent}% plus ${GOCARDLESS.fixedPence}p of each payment, capped at ${pounds(GOCARDLESS.capPence)}. No monthly fee. GoCardless adds VAT to its fees.`,
    usage: {
      label: "Payments asked for",
      used: readings.last.payments.length,
      limit: null,
      unit: "payments",
    },
    tiers: [
      { name: "Standard", current: true, monthlyPence: 0, limit: "1% + 20p a payment" },
      {
        name: "Advanced and Pro",
        current: false,
        monthlyPence: null,
        limit: "Higher fees for extra features",
      },
    ],
    pence: {
      now: fees(readings.last.payments),
      next: readings.payingBusinesses * goCardlessFeePence(typical),
    },
    measured: false,
    drivenBy: "Paying businesses",
    warnings: [],
  };
}

function azure(): ServiceCostView {
  const current = DATABASE_TIERS.find((tier) => tier.id === CURRENT_PLANS.database)!;
  const total = current.pence + AZURE_OTHER_PENCE;
  const warnings: Warning[] = [];
  if (DATABASE_CONNECTIONS_USED >= current.connections * NEAR_LIMIT) {
    const bigger = DATABASE_TIERS[DATABASE_TIERS.indexOf(current) + 1];
    warnings.push({
      direction: "up",
      text: `A release uses ${DATABASE_CONNECTIONS_USED} of the database's ${current.connections} connections at its peak, so there's no room for more app copies on this size.${bigger ? ` ${bigger.name} is ${pounds(bigger.pence)} a month, ${pounds(bigger.pence - current.pence)} more.` : ""}`,
    });
  }
  return {
    id: "azure",
    name: "Microsoft Azure",
    purpose: "Hosting: the API, the worker, the database and its backups",
    plan: `Database ${current.name}`,
    pricing: `A fixed monthly cost that doesn't change with calls: about ${pounds(current.pence)} for the database server and ${pounds(AZURE_OTHER_PENCE)} for storage, the registry, logs and the apps (decision 011's estimate). Azure's Cost Management has the real figure.`,
    usage: {
      label: "Database connections at a release's peak",
      used: DATABASE_CONNECTIONS_USED,
      limit: current.connections,
      unit: "connections",
    },
    tiers: tiers(DATABASE_TIERS, current, (tier) => ({
      monthlyPence: tier.pence,
      limit: `${tier.connections} connections`,
    })),
    pence: { now: total, next: total },
    measured: false,
    drivenBy: "Fixed",
    warnings,
  };
}

function clerk(readings: ServiceReadings): ServiceCostView {
  const warnings: Warning[] = [];
  if (readings.logins >= CLERK.freeUsers * NEAR_LIMIT) {
    warnings.push({
      direction: "up",
      text: `${readings.logins} logins is close to the ${CLERK.freeUsers.toLocaleString("en-GB")} Clerk's free plan includes. Pro is ${pounds(CLERK.proPence)} a month.`,
    });
  }
  return {
    id: "clerk",
    name: "Clerk",
    purpose: "Dashboard logins",
    plan: "Hobby (free)",
    pricing: "Free up to 50,000 returning users a month.",
    usage: { label: "Logins", used: readings.logins, limit: CLERK.freeUsers, unit: "people" },
    tiers: [
      {
        name: "Hobby",
        current: true,
        monthlyPence: 0,
        limit: `${CLERK.freeUsers.toLocaleString("en-GB")} users a month`,
      },
      {
        name: "Pro",
        current: false,
        monthlyPence: CLERK.proPence,
        limit: "More users, charged for each over 50,000",
      },
    ],
    pence: { now: 0, next: 0 },
    measured: false,
    drivenBy: "People with a login",
    warnings,
  };
}

function small(): ServiceCostView[] {
  return [
    {
      id: "uptimerobot",
      name: "UptimeRobot",
      purpose: "Checks every 5 minutes that the service is up",
      plan: "Free",
      pricing: "Free for 50 monitors checked every 5 minutes.",
      usage: {
        label: "Monitors",
        used: UPTIME.monitorsUsed,
        limit: UPTIME.freeMonitors,
        unit: "monitors",
      },
      tiers: [
        { name: "Free", current: true, monthlyPence: 0, limit: "50 monitors, every 5 minutes" },
        {
          name: "Solo",
          current: false,
          monthlyPence: UPTIME.soloPence,
          limit: "10 monitors, every minute",
        },
      ],
      pence: { now: 0, next: 0 },
      measured: false,
      drivenBy: "Fixed",
      warnings: [],
    },
    {
      id: "domain",
      name: "Porkbun",
      purpose: "The brockersby.co.uk domain",
      plan: "Yearly renewal",
      pricing: "$5.66 a year, shown here as a month's share.",
      usage: null,
      tiers: [
        {
          name: "Domain",
          current: true,
          monthlyPence: DOMAIN_PENCE_PER_MONTH,
          limit: "Renews yearly",
        },
      ],
      pence: { now: DOMAIN_PENCE_PER_MONTH, next: DOMAIN_PENCE_PER_MONTH },
      measured: false,
      drivenBy: "Fixed",
      warnings: [],
    },
  ];
}

/** Everything the Costs tab shows about suppliers, from one set of readings. */
export function serviceCosts(
  readings: ServiceReadings,
): Omit<ServiceCostsView, "from" | "to" | "accounts"> {
  const minutes = trend(
    Math.ceil(readings.last.callSeconds / 60),
    Math.ceil(readings.previous.callSeconds / 60),
  );
  const calls = trend(readings.last.calls, readings.previous.calls);
  // Postmark's own count where it could be read: it has the alert emails ours misses.
  const sent = readings.accounts?.postmark ?? null;
  const emails = sent
    ? trend(sent.last.sent, sent.previous.sent)
    : trend(readings.last.emails, readings.previous.emails);
  const segments = trend(readings.last.textSegments, readings.previous.textSegments);
  const services = [
    retell(readings, minutes),
    twilio(readings, minutes, segments),
    anthropic(readings, calls),
    postmark(emails, sent?.last ?? null),
    goCardless(readings),
    azure(),
    clerk(readings),
    ...small(),
  ];
  const now = services.reduce((total, service) => total + service.pence.now, 0);
  const next = services.reduce((total, service) => total + service.pence.next, 0);
  return {
    windowDays: SERVICE_WINDOW_DAYS,
    services,
    growth: { calls, minutes, emails, textSegments: segments },
    totals: {
      nowPence: now,
      nextPence: next,
      incomePence: readings.incomePence,
      marginPence: readings.incomePence - now,
      payingBusinesses: readings.payingBusinesses,
      // What a minute of call costs in the metered services alone, in hundredths of a penny.
      perMinuteHundredths:
        minutes.last === 0
          ? null
          : Math.round(
              ((readings.last.pence.voicePlatform +
                readings.last.pence.languageModel +
                readings.last.pence.texts +
                readings.last.pence.phoneMinutes +
                readings.last.pence.transcription) *
                100) /
                minutes.last,
            ),
    },
  };
}
