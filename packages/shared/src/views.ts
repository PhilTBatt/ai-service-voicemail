// What the dashboard API (apps/api/src/routes/dashboard.ts) sends, shared with the dashboard
// (apps/web). Both sides are type-checked against these shapes, so a change on one side that
// the other doesn't expect fails `npm run typecheck` instead of breaking a page at runtime.
// Times are ISO 8601 instants in UTC; the dashboard shows them in UK time.
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
  createdAt: string;
  calls: { last30Days: number; total: number };
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
}

/** PUT /api/admin/kill-switch */
export interface KillSwitchView {
  killSwitchOn: boolean;
}

/** One call in GET /api/admin/review-queue: a call the pipeline flagged, with its business. */
export interface FlaggedCallView extends CallSummaryView {
  tenant: { id: string; businessName: string };
}

export interface ReviewQueueView {
  calls: FlaggedCallView[];
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
