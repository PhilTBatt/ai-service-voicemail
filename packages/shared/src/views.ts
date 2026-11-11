// What the dashboard API (apps/api/src/routes/dashboard.ts) sends, shared with the dashboard
// (apps/web). Both sides are type-checked against these shapes, so a change on one side that
// the other doesn't expect fails `npm run typecheck` instead of breaking a page at runtime.
// Times are ISO 8601 instants in UTC; the dashboard shows them in UK time.
import type { OnboardingState } from "./onboarding.ts";
import type { LegalDocumentType, MobileNetwork } from "./signup.ts";
import type { AgentProfileInput } from "./profile.ts";

export type Role = "owner" | "admin" | "reseller";

export const URGENCIES = ["emergency", "urgent", "routine", "spam", "other"] as const;
export type Urgency = (typeof URGENCIES)[number];

/** GET /api/me */
export interface MeView {
  userId: string;
  email: string;
  role: Role;
  tenantIds: string[];
}

/** One row of GET /api/tenants. Counts only: the reseller sees this and nothing below it. */
export interface TenantListItem {
  id: string;
  businessName: string;
  trade: string;
  status: string;
  /** Where the business is on the way to going live. The reseller may see this. */
  onboardingState: OnboardingState;
  createdAt: string;
  calls: { last30Days: number; total: number };
  /**
   * Plan and billing status (Step 12), which the reseller may see too: whether it's a pilot,
   * where its Direct Debit stands, and how the latest month's charge went. No amounts.
   */
  billing: {
    isPilot: boolean;
    directDebit: "none" | "pending" | "active" | "ended";
    lastCharge: string | null;
  };
}

export interface TenantListView {
  tenants: TenantListItem[];
}

/** GET /api/tenants/:id */
export interface TenantView {
  id: string;
  businessName: string;
  trade: string;
  status: string;
  contactName: string | null;
  notificationMobile: string | null;
  notificationEmail: string | null;
  serviceRegion: string;
  createdAt: string;
  /** The business's AnswerMate number (E.164), or null before one is bought. */
  number: string | null;
  /** For the divert instructions; null when the business didn't say (invited, not signed up). */
  mobileNetwork: MobileNetwork | null;
  /** When it asked to cancel, and when its number may then be released; null if it hasn't. */
  cancellationRequestedAt: string | null;
  releaseDueAt: string | null;
  /** Documents whose current version the business hasn't accepted: the dashboard asks the owner. */
  documentsToAccept: LegalDocumentType[];
}

/** One legal document, and where this business stands with it. */
export interface DocumentView {
  type: LegalDocumentType;
  title: string;
  /** The current version: what accepting now records. */
  version: string;
  summary: string;
  /** The full text, once there is one. */
  url: string | null;
  /** False while it's a placeholder: only a test business can go live on it. */
  approved: boolean;
  /** The latest version this business accepted, and when; null if it never has. */
  acceptedVersion: string | null;
  acceptedAt: string | null;
  /** True when the accepted version isn't the current one. */
  needsAccepting: boolean;
}

/** GET /api/tenants/:id/documents, and the answer to POST .../documents/accept. */
export interface DocumentsView {
  documents: DocumentView[];
}

/** A call as a list shows it: no transcript, no recording. */
export interface CallSummaryView {
  callId: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  callerNumber: string | null;
  urgency: string | null;
  summary: string | null;
  flags: string[];
  fields: { callerName: string | null; callbackNumber: string | null; postcode: string | null };
  viaFallback: boolean;
  /** When the tradesperson marked it called back; null while it still needs a reply. */
  handledAt: string | null;
}

/** GET /api/tenants/:id/calls. `nextBefore` is the cursor for the next page, or null at the end. */
export interface CallListView {
  calls: CallSummaryView[];
  nextBefore: string | null;
}

export interface TranscriptTurnView {
  role: "agent" | "caller";
  text: string;
}

/** GET /api/tenants/:id/calls/:callId, and the signed call page. */
export interface CallView extends CallSummaryView {
  transcript: TranscriptTurnView[] | null;
  recording: { available: boolean; url: string };
}

/** PUT /api/tenants/:id/calls/:callId/handled */
export interface CallHandledView {
  callId: string;
  handledAt: string | null;
}

/** PUT /api/tenants/:id/switch */
export interface SwitchView {
  outcome: "paused" | "resumed" | "unchanged";
  status: string;
}

/** How the latest saved profile is getting on at the voice platform. */
export interface SyncView {
  /** pending: saved, waiting for the worker; live: the agent uses it; error: the sync failed. */
  state: "pending" | "live" | "error";
  syncedAt: string | null;
  /** The voice platform's error, for an admin. A tenant sees a plain message instead. */
  error: string | null;
}

/** GET /api/tenants/:id/profile. All null before the first save. */
export interface ProfileView {
  profile: AgentProfileInput | null;
  version: number | null;
  sync: SyncView | null;
}

/** PUT /api/tenants/:id/profile */
export interface SaveProfileView {
  version: number;
  sync: SyncView;
}

/** POST /api/tenants/:id/cancel */
export interface CancellationView {
  outcome: "cancelling";
  status: "cancelling";
}

/** GET /api/admin/health. Counts cover the last 24 hours. */
export interface HealthView {
  killSwitchOn: boolean;
  /** Calls that went to the fallback voicemail: the agent couldn't be reached. */
  fallbackCalls: number;
  /** Texts and emails that failed or bounced. */
  failedNotifications: number;
  /** Jobs that failed every retry. */
  deadLetteredJobs24h: number;
  /** Businesses whose latest profile failed to reach the voice platform. */
  failedSyncs: { tenantId: string; businessName: string; version: number; error: string }[];
  /**
   * The worker's last check-in: running, down (four check-ins missed), or never (none on
   * record). Without a worker, no syncs, summaries or texts happen.
   */
  worker: { state: "running" | "down" | "never"; lastSeen: string | null };
  /**
   * The recurring jobs the worker has run (the two reconciliations, retention, billing): when
   * each last succeeded and failed, and whether it's overdue, meaning it has stopped running.
   */
  scheduledJobs: {
    queue: string;
    label: string;
    lastSucceededAt: string | null;
    lastFailedAt: string | null;
    overdue: boolean;
  }[];
  /** Businesses whose latest profile has waited over 5 minutes, neither synced nor failed. */
  waitingSyncs: { tenantId: string; businessName: string; version: number; savedAt: string }[];
  /** The latest texts and emails that couldn't be sent, newest first, with the provider's reason. */
  failedNotificationsRecent: {
    tenantId: string;
    businessName: string;
    callId: string;
    channel: string;
    status: string;
    attempts: number;
    failureCode: string | null;
    failureReason: string | null;
    at: string;
  }[];
  /** The latest jobs that failed every retry, newest first, with the error that ended them. */
  deadLetteredJobsRecent: {
    queue: string;
    tenantId: string | null;
    callId: string | null;
    error: string | null;
    at: string;
  }[];
}

/** GET /api/tenants/:id/billing: the plan, this month so far, and the Direct Debit (Step 12). */
export interface BillingView {
  /** Whether payments are set up on this server at all; without, Direct Debit can't be started. */
  available: boolean;
  plan: {
    name: string;
    monthlyPence: number;
    includedMinutes: number;
    overagePencePerMinute: number;
  };
  isPilot: boolean;
  /**
   * The current billing month, from the day the business went live, with its fee and the
   * billable time so far. Null before it goes live: nothing is billed until then.
   */
  period: {
    start: string;
    end: string;
    /** 1 for the first month. */
    month: number;
    feePence: number;
    billableSeconds: number;
  } | null;
  directDebit: {
    status: "none" | "pending" | "active" | "ended";
    since: string | null;
    endReason: string | null;
  };
  /** The months charged so far, newest first (the last twelve). */
  charges: BillingChargeView[];
}

/** One month's charge, as the business sees it on its Account tab. */
export interface BillingChargeView {
  periodStart: string;
  periodEnd: string;
  lines: { description: string; pence: number }[];
  vatPence: number;
  totalPence: number;
  /**
   * nothing_due, no_mandate (owed, with no Direct Debit to collect from), collecting, pending,
   * submitted, confirmed, paid_out, failed, cancelled, charged_back.
   */
  status: string;
  /** The day the money is collected, once a payment is made. */
  chargeDate: string | null;
}

/** POST /api/tenants/:id/billing/direct-debit: where to send the person to set it up. */
export interface DirectDebitStartView {
  authorisationUrl: string;
}

/** GET /api/admin/billing: this month's money, and the charges that need a person (Step 12). */
export interface AdminBillingView {
  /** Whether payments are set up on this server; without, nothing can be collected again. */
  available: boolean;
  thisMonth: { collectedPence: number; collectingPence: number; problemPence: number };
  attention: {
    chargeId: string;
    tenantId: string;
    businessName: string;
    periodStart: string;
    periodEnd: string;
    totalPence: number;
    status: string;
    failureReason: string | null;
    canCollectAgain: boolean;
  }[];
}

/** POST /api/admin/tenants/:id/suspend and /resume */
export interface SuspensionView {
  outcome: "suspended" | "resumed" | "unchanged";
  status: string;
}

/** PUT /api/admin/kill-switch */
export interface KillSwitchView {
  killSwitchOn: boolean;
}

/** One call in GET /api/admin/review-queue: a call the pipeline flagged, with its business. */
export interface FlaggedCallView extends CallSummaryView {
  tenant: { id: string; businessName: string };
}

/** GET /api/admin/review-queue. `nextBefore` is the cursor for the next page, or null at the end. */
export interface ReviewQueueView {
  calls: FlaggedCallView[];
  nextBefore: string | null;
}

/** POST /api/admin/calls/:callId/reviewed: the call has left the review queue. */
export interface CallReviewedView {
  callId: string;
  reviewedAt: string;
}

/** One business in GET /api/admin/usage: billable time in the period containing today. */
export interface UsageRowView {
  tenantId: string;
  businessName: string;
  status: string;
  /** YYYY-MM-DD, or null when the business has no usage this period yet. */
  periodStart: string | null;
  periodEnd: string | null;
  billableSeconds: number;
  calls: number;
}

export interface UsageView {
  tenants: UsageRowView[];
}

/** One business in GET /api/admin/costs. Whole pence. */
export interface CostRowView {
  tenantId: string;
  businessName: string;
  status: string;
  calls: number;
  pence: {
    voicePlatform: number;
    languageModel: number;
    texts: number;
    phoneMinutes: number;
    number: number;
    total: number;
  };
}

/** GET /api/admin/costs: estimated supplier costs for the UK calendar month containing today. */
export interface CostsView {
  periodStart: string;
  periodEnd: string;
  tenants: CostRowView[];
  /** The prices and assumptions behind the figures, in words. */
  assumptions: string[];
  /** Cost lines the price list doesn't cover, so they're missing from the figures. */
  unpriced: string[];
}

/** GET /api/admin/numbers/available: UK local numbers that can be bought now. */
export interface AvailableNumbersView {
  numbers: { number: string; locality: string | null; region: string | null }[];
  /** Monthly rental for a local number, in whole pence; null if the supplier prices it in another currency. */
  monthlyPence: number | null;
  /** False when this server refuses purchases (TWILIO_PURCHASES_ENABLED isn't true). */
  purchasesEnabled: boolean;
}

/** POST /api/admin/tenants/:id/number */
export interface ProvisionedNumberView {
  number: string;
  providerSid: string;
}

/** GET /api/admin/cancellations: businesses that are leaving, and whose numbers can go. */
export interface CancellationsView {
  tenants: {
    tenantId: string;
    businessName: string;
    /** cancelling: in its 30 days. cancelled: number released, data still here to delete. */
    status: "cancelling" | "cancelled";
    cancellationRequestedAt: string;
    releaseDueAt: string;
    /** Their AnswerMate number, or null if they never had one. */
    number: string | null;
    /** The 30 days are up: the number can be released. */
    due: boolean;
  }[];
}

/** POST /api/admin/tenants/:id/delete-data: the worker does the deleting. */
export interface DataDeletionView {
  queued: true;
}

/** POST /api/admin/tenants/:id/release-number */
export interface ReleasedNumberView {
  released: string | null;
  status: "cancelled";
}
