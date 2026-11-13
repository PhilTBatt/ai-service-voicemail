// ┌──────────────────────────────────────────────────────────────────────────────────────┐
// │ CROSS-TENANT ACCESS. Everything that can reach more than one tenant's data lives      │
// │ here, and only here. Tenant-facing code uses withTenant() (./tenant.ts) instead.       │
// └──────────────────────────────────────────────────────────────────────────────────────┘
import { createHash, randomBytes } from "node:crypto";
import {
  LEGAL_DOCUMENT_TYPES,
  LEGAL_DOCUMENTS,
  type SignupInput,
  type Trade,
} from "@callmate/shared";
import type pg from "pg";
import { endedPeriods, ukDateOf } from "../core/billing.ts";
import type { CostPrices } from "../core/prices.ts";
import { REVIEW_FLAGS } from "../core/review.ts";
import { startOfUkDate, usagePeriodFor } from "../core/usage.ts";
import { ADMIN_POOL_MAX, createPool } from "./pool.ts";

/**
 * Finds which tenant owns an active number, for webhooks that arrive before any tenant is
 * known. Runs as the app role through a database function that returns only the tenant ID.
 */
export async function findTenantIdByNumber(
  appPool: pg.Pool,
  dialledNumber: string,
): Promise<string | null> {
  const { rows } = await appPool.query<{ tenant_id: string | null }>(
    "SELECT tenant_id_for_number($1) AS tenant_id",
    [dialledNumber],
  );
  return rows[0]?.tenant_id ?? null;
}

/**
 * Finds the tenant whose registered mobile sent a text, for the SMS command webhook. Only an
 * unambiguous match counts: two tenants sharing a mobile get nothing (and no reply).
 */
export async function findTenantIdByMobile(
  appPool: pg.Pool,
  mobile: string,
): Promise<string | null> {
  const { rows } = await appPool.query<{ tenant_id: string | null }>(
    "SELECT tenant_id_for_mobile($1) AS tenant_id",
    [mobile],
  );
  return rows[0]?.tenant_id ?? null;
}

/** Finds the tenant a call belongs to, for the signed call page (the link carries only the call ID). */
export async function findTenantIdByCall(appPool: pg.Pool, callId: string): Promise<string | null> {
  const { rows } = await appPool.query<{ tenant_id: string | null }>(
    "SELECT tenant_id_for_call($1) AS tenant_id",
    [callId],
  );
  return rows[0]?.tenant_id ?? null;
}

// The admin pool is "branded": a plain pg.Pool (like the app's) doesn't fit this type, so
// admin functions can't be handed the wrong connection by mistake.
export type AdminPool = pg.Pool & { readonly __brand: "AdminPool" };

/** Connects as callmate_admin, which sees every tenant. Only for admin work and seeding. */
export function createAdminPool(
  adminDatabaseUrl: string,
  { max = ADMIN_POOL_MAX } = {},
): AdminPool {
  const pool = createPool(adminDatabaseUrl, { max });
  // The admin functions hold a connection through a transaction or a lock. If it dies while
  // held (the database restarting), it emits an 'error' that the pool only listens for while
  // the connection is idle: unheard, Node would stop the whole process. The query in flight
  // fails with the same error, which is what reports it; this only keeps the process up.
  pool.on("acquire", (client) => client.on("error", ignoreHeldConnectionError));
  pool.on("release", (_error, client) => client.removeListener("error", ignoreHeldConnectionError));
  return pool as AdminPool;
}

function ignoreHeldConnectionError(): void {}

export interface NewTenant {
  /** Normally generated. Seed data passes a fixed one so re-running the seed is harmless. */
  id?: string;
  businessName: string;
  trade: Trade;
  status?: "onboarding" | "demo";
  notificationMobile?: string;
  notificationEmail?: string;
  serviceRegion?: "GB" | "NI";
  /** The tradesperson's name, as callers will hear it. Required before the agent can sync. */
  contactName?: string;
}

export async function createTenant(admin: AdminPool, tenant: NewTenant): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO tenants (id, business_name, trade, status, notification_mobile, notification_email, service_region, contact_name)
     VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      tenant.id ?? null,
      tenant.businessName,
      tenant.trade,
      tenant.status ?? "onboarding",
      tenant.notificationMobile ?? null,
      tenant.notificationEmail ?? null,
      tenant.serviceRegion ?? "GB",
      tenant.contactName ?? null,
    ],
  );
  return rows[0]!.id;
}

/** Gives a tenant its dedicated number. The database allows one active number per tenant. */
export async function assignPhoneNumber(
  admin: AdminPool,
  tenantId: string,
  number: string,
  providerSid: string,
): Promise<void> {
  await admin.query(
    "INSERT INTO phone_numbers (tenant_id, number, provider_sid) VALUES ($1, $2, $3)",
    [tenantId, number, providerSid],
  );
}

export interface TenantSummary {
  id: string;
  businessName: string;
  status: string;
}

export async function listTenants(admin: AdminPool): Promise<TenantSummary[]> {
  const { rows } = await admin.query<TenantSummary>(
    `SELECT id, business_name AS "businessName", status FROM tenants ORDER BY created_at`,
  );
  return rows;
}

/** A tenant as the dashboard lists it (Step 10): the summary plus how busy its line is. */
export interface TenantWithCallCounts extends TenantSummary {
  trade: string;
  onboardingState: import("@callmate/shared").OnboardingState;
  createdAt: Date;
  callsLast30Days: number;
  callsTotal: number;
  isPilot: boolean;
  directDebit: "none" | "pending" | "active" | "ended";
  lastCharge: string | null;
}

/**
 * The billing columns of the tenant list (Step 12), for a tenant aliased `t`: the pilot flag,
 * the Direct Debit's state (as directDebitState() reads it), and the latest charge's status.
 * Shared by the admin's list and an owner's, so the two can't drift.
 */
export const TENANT_BILLING_COLUMNS = `t.is_pilot AS "isPilot",
  COALESCE((SELECT CASE m.status WHEN 'active' THEN 'active' WHEN 'pending' THEN 'pending'
                                 WHEN 'abandoned' THEN 'none' ELSE 'ended' END
            FROM payment_mandates m WHERE m.tenant_id = t.id
            ORDER BY (m.status = 'active') DESC, m.created_at DESC LIMIT 1), 'none') AS "directDebit",
  (SELECT b.status FROM billing_charges b WHERE b.tenant_id = t.id
   ORDER BY b.period_start DESC LIMIT 1) AS "lastCharge"`;

/** Every tenant with its call counts. Counts are safe for the reseller; nothing else here is content. */
export async function listTenantsWithCallCounts(admin: AdminPool): Promise<TenantWithCallCounts[]> {
  const { rows } = await admin.query<TenantWithCallCounts>(
    `SELECT t.id, t.business_name AS "businessName", t.trade, t.status,
            t.onboarding_state AS "onboardingState", t.created_at AS "createdAt",
            COUNT(c.id) FILTER (WHERE c.started_at >= now() - interval '30 days')::int AS "callsLast30Days",
            COUNT(c.id)::int AS "callsTotal",
            ${TENANT_BILLING_COLUMNS}
     FROM tenants t LEFT JOIN calls c ON c.tenant_id = t.id
     GROUP BY t.id ORDER BY t.created_at`,
  );
  return rows;
}

// ─── Admin screens (BUILD_PLAN Step 10) ────────────────────────────────────────────────

export interface HealthSnapshot {
  killSwitchOn: boolean;
  /** Calls that went to the fallback voicemail since `since`: the agent couldn't be reached. */
  fallbackCalls: number;
  /** Texts and emails that failed or bounced since `since`. */
  failedNotifications: number;
  /** Tenants whose latest profile version failed to sync, with the error. */
  failedSyncs: { tenantId: string; businessName: string; version: number; error: string }[];
  /** When the worker last checked in (db/worker-heartbeat.ts), or null if it never has. */
  workerSeenAt: Date | null;
  /**
   * Tenants whose latest profile was saved before `waitingBefore` and has neither synced nor
   * failed: nothing has run its sync, which a worker that's down looks like.
   */
  waitingSyncs: { tenantId: string; businessName: string; version: number; savedAt: Date }[];
}

export async function healthSnapshot(
  admin: AdminPool,
  { since, waitingBefore }: { since: Date; waitingBefore: Date },
): Promise<HealthSnapshot> {
  const [counts, syncs, waiting] = await Promise.all([
    admin.query<{
      kill_switch_on: boolean;
      fallback_calls: number;
      failed_notifications: number;
      worker_seen_at: Date | null;
    }>(
      `SELECT (SELECT kill_switch_on FROM system_settings) AS kill_switch_on,
              (SELECT count(*) FROM calls WHERE via_fallback AND started_at >= $1)::int AS fallback_calls,
              (SELECT count(*) FROM notifications
                WHERE status IN ('failed', 'undelivered') AND updated_at >= $1)::int AS failed_notifications,
              (SELECT seen_at FROM worker_heartbeat) AS worker_seen_at`,
      [since],
    ),
    admin.query<{ tenantId: string; businessName: string; version: number; error: string }>(
      `SELECT t.id AS "tenantId", t.business_name AS "businessName", p.version, p.sync_error AS error
       FROM tenants t
       JOIN LATERAL (SELECT version, sync_error FROM agent_profiles
                     WHERE tenant_id = t.id ORDER BY version DESC LIMIT 1) p ON true
       WHERE p.sync_error IS NOT NULL
       ORDER BY t.business_name`,
    ),
    // A cancelled business's agent is gone, so its last profile has nothing to sync to.
    admin.query<{ tenantId: string; businessName: string; version: number; savedAt: Date }>(
      `SELECT t.id AS "tenantId", t.business_name AS "businessName", p.version,
              p.created_at AS "savedAt"
       FROM tenants t
       JOIN LATERAL (SELECT version, synced_at, sync_error, created_at FROM agent_profiles
                     WHERE tenant_id = t.id ORDER BY version DESC LIMIT 1) p ON true
       WHERE p.synced_at IS NULL AND p.sync_error IS NULL AND p.created_at < $1
         AND t.status <> 'cancelled'
       ORDER BY p.created_at`,
      [waitingBefore],
    ),
  ]);
  const row = counts.rows[0]!;
  return {
    killSwitchOn: row.kill_switch_on,
    fallbackCalls: row.fallback_calls,
    failedNotifications: row.failed_notifications,
    failedSyncs: syncs.rows,
    workerSeenAt: row.worker_seen_at,
    waitingSyncs: waiting.rows,
  };
}

/** The voicemail transcription switch and the figures behind the Admin page's estimate (decision 022). */
export interface VoicemailTranscriptionSnapshot {
  on: boolean;
  /** The provider's per-minute price in whole pence, at our exchange rate. */
  perMinutePence: number;
  voicemails: number;
  transcribable: number;
  minutes: number;
  wouldCostPence: number;
  asked: number;
  waiting: number;
  transcribed: number;
  failed: number;
  spentPence: number;
}

/**
 * The last window's fallback voicemails and what transcribing them costs or would cost: each one
 * counted as whole minutes, rounded up, at the provider's per-minute dollar price and our
 * pounds-per-dollar rate, summed exactly in the database and rounded to pence once (CLAUDE.md:
 * no money in floating point).
 */
export async function voicemailTranscriptionSnapshot(
  admin: AdminPool,
  { since, minSeconds }: { since: Date; minSeconds: number },
  prices: Pick<CostPrices, "transcriptionPerMinuteUsd" | "gbpPerUsd">,
): Promise<VoicemailTranscriptionSnapshot> {
  const { rows } = await admin.query<{
    on: boolean;
    per_minute_pence: number;
    voicemails: number;
    transcribable: number;
    minutes: number;
    would_cost_pence: number;
    asked: number;
    waiting: number;
    transcribed: number;
    failed: number;
    spent_pence: number;
  }>(
    `WITH v AS (
       SELECT transcription_status, transcription_ref,
              coalesce((extracted_fields ->> 'recordingSeconds')::numeric, 0) AS seconds
       FROM calls WHERE via_fallback AND started_at >= $1
     ),
     m AS (
       SELECT count(*)::int AS voicemails,
              count(*) FILTER (WHERE seconds >= $2)::int AS transcribable,
              coalesce(sum(ceil(seconds / 60)) FILTER (WHERE seconds >= $2), 0) AS minutes,
              count(*) FILTER (WHERE transcription_ref IS NOT NULL)::int AS asked,
              count(*) FILTER (WHERE transcription_status = 'requested')::int AS waiting,
              count(*) FILTER (WHERE transcription_status = 'completed')::int AS transcribed,
              count(*) FILTER (WHERE transcription_status = 'failed')::int AS failed,
              coalesce(sum(ceil(seconds / 60)) FILTER (WHERE transcription_ref IS NOT NULL), 0) AS asked_minutes
       FROM v
     )
     SELECT (SELECT voicemail_transcription_on FROM system_settings) AS "on",
            round($3::numeric * $4::numeric * 100)::int AS per_minute_pence,
            m.voicemails, m.transcribable, m.minutes::int AS minutes,
            round(m.minutes * $3::numeric * $4::numeric * 100)::int AS would_cost_pence,
            m.asked, m.waiting, m.transcribed, m.failed,
            round(m.asked_minutes * $3::numeric * $4::numeric * 100)::int AS spent_pence
     FROM m`,
    [since, minSeconds, prices.transcriptionPerMinuteUsd, prices.gbpPerUsd],
  );
  const row = rows[0]!;
  return {
    on: row.on,
    perMinutePence: row.per_minute_pence,
    voicemails: row.voicemails,
    transcribable: row.transcribable,
    minutes: row.minutes,
    wouldCostPence: row.would_cost_pence,
    asked: row.asked,
    waiting: row.waiting,
    transcribed: row.transcribed,
    failed: row.failed,
    spentPence: row.spent_pence,
  };
}

/** Flips the voicemail transcription switch (decision 022) and audits who did it. */
export async function setVoicemailTranscription(
  admin: AdminPool,
  on: boolean,
  actorUserId: string,
): Promise<void> {
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE system_settings SET voicemail_transcription_on = $1", [on]);
    await client.query(
      "INSERT INTO audit_log (tenant_id, actor_user_id, action, details) VALUES (NULL, $1, $2, $3)",
      [
        actorUserId,
        on ? "voicemail-transcription.on" : "voicemail-transcription.off",
        { via: "dashboard" },
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Flips the kill switch (core/routing.ts reads it on every call) and audits who did it. */
export async function setKillSwitch(
  admin: AdminPool,
  on: boolean,
  actorUserId: string,
): Promise<void> {
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE system_settings SET kill_switch_on = $1", [on]);
    await client.query(
      "INSERT INTO audit_log (tenant_id, actor_user_id, action, details) VALUES (NULL, $1, $2, $3)",
      [actorUserId, on ? "kill-switch.on" : "kill-switch.off", { via: "dashboard" }],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Records something an admin did to a tenant, and who did it (decision 006: every admin action). */
export async function auditAdminAction(
  admin: AdminPool,
  entry: { tenantId: string; actorUserId: string; action: string; details: object },
): Promise<void> {
  await admin.query(
    "INSERT INTO audit_log (tenant_id, actor_user_id, action, details) VALUES ($1, $2, $3, $4)",
    [entry.tenantId, entry.actorUserId, entry.action, entry.details],
  );
}

/**
 * Records what a script did (npm run invite-user, the live-* number scripts): nobody is
 * logged in, so there's no person, and the details say "script". BUILD_PLAN Step 10: every
 * admin action is recorded, and granting admin is the one most worth having on record.
 */
export interface FailedNotification {
  tenantId: string;
  businessName: string;
  callId: string;
  channel: string;
  /** 'failed': the send threw (failureReason says what); 'undelivered': the carrier's verdict (failureCode). */
  status: string;
  attempts: number;
  failureCode: string | null;
  failureReason: string | null;
  at: Date;
}

/** The latest texts and emails that couldn't be sent, newest first, for the admin's health screen. */
export async function recentFailedNotifications(
  admin: AdminPool,
  since: Date,
  limit = 10,
): Promise<FailedNotification[]> {
  const { rows } = await admin.query<FailedNotification>(
    `SELECT n.tenant_id AS "tenantId", t.business_name AS "businessName", n.call_id AS "callId",
            n.channel, n.status, n.attempts, n.failure_code AS "failureCode",
            n.failure_reason AS "failureReason", n.updated_at AS at
     FROM notifications n JOIN tenants t ON t.id = n.tenant_id
     WHERE n.status IN ('failed', 'undelivered') AND n.updated_at >= $1
     ORDER BY n.updated_at DESC
     LIMIT $2`,
    [since, limit],
  );
  return rows;
}

/**
 * Makes an account claimable again by its email: the next sign-in with that verified address
 * takes it, as a first sign-in would. For when the login provider changes (Clerk's production
 * instance gives everyone a new subject) or someone has lost their old login. True if there
 * was a claimed account to reset.
 */
export async function resetLogin(admin: AdminPool, email: string): Promise<boolean> {
  const { rowCount } = await admin.query(
    "UPDATE users SET auth_subject = NULL WHERE lower(email) = lower($1) AND auth_subject IS NOT NULL",
    [email],
  );
  return (rowCount ?? 0) > 0;
}

export async function auditScriptAction(
  admin: AdminPool,
  entry: { tenantId: string | null; action: string; details: object },
): Promise<void> {
  await admin.query(
    "INSERT INTO audit_log (tenant_id, actor_user_id, action, details) VALUES ($1, NULL, $2, $3)",
    [entry.tenantId, entry.action, { via: "script", ...entry.details }],
  );
}

/** Whether there's a business with this ID (any status). A malformed ID is simply "no". */
export async function tenantExists(admin: AdminPool, tenantId: string): Promise<boolean> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
    return false;
  }
  return (await admin.query("SELECT 1 FROM tenants WHERE id = $1", [tenantId])).rowCount === 1;
}

/**
 * Runs `work` while holding a lock named `key` that no other process can take meanwhile, or
 * returns { held: false } straight away if another holds it. For actions that mustn't overlap
 * for one business: buying its number, deleting its data.
 */
export async function withAdvisoryLock<T>(
  admin: AdminPool,
  key: string,
  work: () => Promise<T>,
): Promise<{ held: true; result: T } | { held: false }> {
  const client = await admin.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [key],
    );
    if (!rows[0]?.locked) return { held: false };
    try {
      return { held: true, result: await work() };
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [key]);
    }
  } finally {
    client.release();
  }
}

/** A flagged call with the tenant it belongs to, for the admin's review queue. */
export type FlaggedCall = import("../routes/call-view.ts").CallRow & {
  tenant: { id: string; businessName: string };
};

/** Where a page of the review queue starts: after this call, in newest-first order. */
export interface ReviewCursor {
  /** ISO 8601 at the database's full precision (microseconds), so no call is skipped. */
  startedAt: string;
  id: string;
}

/**
 * Calls still to review, newest first: the pipeline's own flags (core/review.ts), not yet
 * marked reviewed. Pages by (started_at, id), so two calls that started in the same instant
 * are neither skipped nor shown twice. `next` is null on the last page.
 */
export async function listFlaggedCalls(
  admin: AdminPool,
  { limit, after }: { limit: number; after?: ReviewCursor | undefined },
): Promise<{ calls: FlaggedCall[]; next: ReviewCursor | null }> {
  // One more than asked for says whether there's another page, without a COUNT.
  const { rows } = await admin.query<
    import("../routes/call-view.ts").CallRow & {
      tenant_id: string;
      business_name: string;
      cursor_at: string;
    }
  >(
    `SELECT c.id, c.provider_call_id, c.started_at, c.ended_at, c.billable_seconds, c.caller_number,
            c.urgency, c.summary, c.flags, c.extracted_fields, c.transcript, c.recording_ref,
            c.via_fallback, c.handled_at, c.tenant_id, t.business_name,
            to_json(c.started_at) #>> '{}' AS cursor_at
     FROM calls c JOIN tenants t ON t.id = c.tenant_id
     WHERE c.flags && $1::text[] AND c.reviewed_at IS NULL
       AND ($2::timestamptz IS NULL OR (c.started_at, c.id) < ($2::timestamptz, $3::uuid))
     ORDER BY c.started_at DESC, c.id DESC
     LIMIT $4`,
    [REVIEW_FLAGS, after?.startedAt ?? null, after?.id ?? null, limit + 1],
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    calls: page.map(({ tenant_id, business_name, cursor_at: _cursor, ...call }) => ({
      ...call,
      tenant: { id: tenant_id, businessName: business_name },
    })),
    next: rows.length > limit && last ? { startedAt: last.cursor_at, id: last.id } : null,
  };
}

/**
 * Takes a call out of the review queue and records who did it (decision 006: every admin
 * action). Marking it again changes nothing and adds no second audit row. Null when there's no
 * such call.
 */
export async function markCallReviewed(
  admin: AdminPool,
  callId: string,
  actorUserId: string,
): Promise<{ reviewedAt: Date } | null> {
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    // The row lock makes two admins marking the same call at once take turns.
    const { rows } = await client.query<{ tenant_id: string; reviewed_at: Date | null }>(
      "SELECT tenant_id, reviewed_at FROM calls WHERE id = $1 FOR UPDATE",
      [callId],
    );
    const call = rows[0];
    if (!call || call.reviewed_at) {
      await client.query("COMMIT");
      return call?.reviewed_at ? { reviewedAt: call.reviewed_at } : null;
    }
    const updated = await client.query<{ reviewed_at: Date }>(
      "UPDATE calls SET reviewed_at = now(), reviewed_by = $2 WHERE id = $1 RETURNING reviewed_at",
      [callId, actorUserId],
    );
    await client.query(
      "INSERT INTO audit_log (tenant_id, actor_user_id, action, details) VALUES ($1, $2, $3, $4)",
      [call.tenant_id, actorUserId, "call.reviewed", { callId }],
    );
    await client.query("COMMIT");
    return { reviewedAt: updated.rows[0]!.reviewed_at };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface TenantUsage {
  tenantId: string;
  businessName: string;
  status: string;
  periodStart: string | null;
  periodEnd: string | null;
  billableSeconds: number;
  calls: number;
}

/**
 * Every tenant's billable seconds and call count for the period containing `today`. Months are
 * UK months: in summer, the first hour of the 1st (UK time) is still the last day of the
 * month before in UTC, which is what the database's own clock would use.
 */
export async function listCurrentUsage(admin: AdminPool, today: Date): Promise<TenantUsage[]> {
  const { periodStart, periodEnd } = usagePeriodFor(today);
  const { rows } = await admin.query<TenantUsage>(
    `SELECT t.id AS "tenantId", t.business_name AS "businessName", t.status,
            to_char(u.period_start, 'YYYY-MM-DD') AS "periodStart",
            to_char(u.period_end, 'YYYY-MM-DD') AS "periodEnd",
            COALESCE(u.billable_seconds, 0)::int AS "billableSeconds",
            (SELECT count(*) FROM calls c
              WHERE c.tenant_id = t.id
                AND c.started_at >= COALESCE(u.period_start::timestamp AT TIME ZONE 'Europe/London', $2)
                AND c.started_at < COALESCE(u.period_end::timestamp AT TIME ZONE 'Europe/London', $3)
            )::int AS calls
     FROM tenants t
     LEFT JOIN usage_periods u
       ON u.tenant_id = t.id AND u.period_start <= $1::date AND u.period_end > $1::date
     ORDER BY t.business_name`,
    // The period that contains today: billing months run from each business's go-live date
    // (decision 019), so the one holding the 1st of the calendar month was usually last
    // month's, or none at all.
    [ukDateOf(today), startOfUkDate(periodStart), startOfUkDate(periodEnd)],
  );
  return rows;
}

/** One tenant's estimated cost in a window. Whole pence, each part rounded once. */
export interface TenantCostEstimate {
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
    /** Voicemails transcribed while the switch was on (decision 022). */
    transcription: number;
    total: number;
  };
}

/**
 * What each tenant's calls cost us in a window, estimated (BUILD_PLAN Step 10's admin screen).
 * - Voice platform: the cost Retell reports for each call, in US cents.
 * - Language model: the extraction's tokens at list price.
 * - Texts: the segments sent.
 * - Phone minutes: each call's length rounded up to whole minutes (an assumption about how
 *   Twilio rounds), for the incoming call, plus the SIP leg to the voice platform when the
 *   assistant answered. Fallback voicemails have no SIP leg.
 * - Number: one month's rental if the tenant has a number now.
 * Everything is summed as exact decimals and rounded to whole pence at the end. Cost lines the
 * price list doesn't cover come back in `unpriced`, so a gap is visible rather than silent.
 */
export async function estimateCosts(
  admin: AdminPool,
  window: { from: Date; to: Date },
  prices: CostPrices,
): Promise<{ tenants: TenantCostEstimate[]; unpriced: string[] }> {
  const models = Object.entries(prices.models);
  const modelArgs = [
    models.map(([name]) => name),
    models.map(([, price]) => String(price.input)),
    models.map(([, price]) => String(price.output)),
  ];
  const { rows } = await admin.query<{
    tenant_id: string;
    business_name: string;
    status: string;
    calls: number;
    voice_platform: number;
    language_model: number;
    texts: number;
    phone_minutes: number;
    number: number;
    transcription: number;
  }>(
    `WITH period_calls AS (
       SELECT id, tenant_id, via_fallback,
              ceil(extract(epoch FROM ended_at - started_at) / 60) AS minutes
       FROM calls WHERE started_at >= $1 AND started_at < $2
     ),
     costs AS (
       SELECT cc.tenant_id, cc.component, cc.unit_type, cc.units
       FROM call_costs cc JOIN period_calls pc ON pc.id = cc.call_id
     ),
     models AS (
       SELECT * FROM unnest($8::text[], $9::numeric[], $10::numeric[]) AS m(model, input_price, output_price)
     )
     SELECT t.id AS tenant_id, t.business_name, t.status,
       (SELECT count(*) FROM period_calls pc WHERE pc.tenant_id = t.id)::int AS calls,
       round(coalesce((SELECT sum(units) FROM costs c
                       WHERE c.tenant_id = t.id AND c.unit_type = 'usd_cents'), 0)
             * $3::numeric)::int AS voice_platform,
       round(coalesce((SELECT sum(c.units * CASE WHEN c.component = m.model || ':input_tokens'
                                                 THEN m.input_price ELSE m.output_price END)
                       FROM costs c
                       JOIN models m ON c.component IN (m.model || ':input_tokens', m.model || ':output_tokens')
                       WHERE c.tenant_id = t.id), 0)
             * $3::numeric / 10000)::int AS language_model,
       round(coalesce((SELECT sum(units) FROM costs c
                       WHERE c.tenant_id = t.id AND c.unit_type = 'segments'), 0)
             * $4::numeric * 100)::int AS texts,
       round(coalesce((SELECT sum(minutes) FROM period_calls pc WHERE pc.tenant_id = t.id), 0)
               * $5::numeric * 100
             + coalesce((SELECT sum(minutes) FROM period_calls pc
                         WHERE pc.tenant_id = t.id AND NOT pc.via_fallback), 0)
               * $6::numeric * $3::numeric * 100)::int AS phone_minutes,
       CASE WHEN EXISTS (SELECT 1 FROM phone_numbers p WHERE p.tenant_id = t.id AND p.status = 'active')
            THEN round($7::numeric * 100)::int ELSE 0 END AS number,
       round(coalesce((SELECT sum(ceil(c.units / 60)) FROM costs c
                       WHERE c.tenant_id = t.id AND c.component = 'twilio:transcription_seconds'), 0)
             * $11::numeric * $3::numeric * 100)::int AS transcription
     FROM tenants t
     ORDER BY t.business_name`,
    [
      window.from,
      window.to,
      prices.gbpPerUsd,
      prices.smsSegmentGbp,
      prices.inboundCallPerMinuteGbp,
      prices.sipPerMinuteUsd,
      prices.localNumberPerMonthGbp,
      ...modelArgs,
      prices.transcriptionPerMinuteUsd,
    ],
  );
  const unpriced = await admin.query<{ component: string }>(
    `SELECT DISTINCT cc.component
     FROM call_costs cc JOIN calls c ON c.id = cc.call_id
     WHERE c.started_at >= $1 AND c.started_at < $2
       AND cc.unit_type NOT IN ('usd_cents', 'segments', 'seconds')
       AND NOT (cc.unit_type = 'tokens'
                AND regexp_replace(cc.component, ':(input|output)_tokens$', '') = ANY($3::text[]))
     ORDER BY 1`,
    [window.from, window.to, modelArgs[0]],
  );
  return {
    tenants: rows.map((row) => ({
      tenantId: row.tenant_id,
      businessName: row.business_name,
      status: row.status,
      calls: row.calls,
      pence: {
        voicePlatform: row.voice_platform,
        languageModel: row.language_model,
        texts: row.texts,
        phoneMinutes: row.phone_minutes,
        number: row.number,
        transcription: row.transcription,
        total:
          row.voice_platform +
          row.language_model +
          row.texts +
          row.phone_minutes +
          row.number +
          row.transcription,
      },
    })),
    unpriced: unpriced.rows.map((row) => row.component),
  };
}

// ─── Leaving (BUILD_PLAN Step 13) ──────────────────────────────────────────────────────

export interface CancellingTenant {
  tenantId: string;
  businessName: string;
  /** cancelling: in its 30 days; cancelled: number released, data not yet deleted. */
  status: "cancelling" | "cancelled";
  cancellationRequestedAt: Date;
  number: string | null;
  providerSid: string | null;
}

/** Businesses that are leaving: in their 30 days, or gone with their data still here. Oldest first. */
export async function listCancellingTenants(admin: AdminPool): Promise<CancellingTenant[]> {
  const { rows } = await admin.query<CancellingTenant>(
    `SELECT t.id AS "tenantId", t.business_name AS "businessName", t.status,
            coalesce(t.cancellation_requested_at, t.updated_at) AS "cancellationRequestedAt",
            n.number, n.provider_sid AS "providerSid"
     FROM tenants t
     LEFT JOIN phone_numbers n ON n.tenant_id = t.id AND n.status = 'active'
     WHERE t.status = 'cancelling' OR (t.status = 'cancelled' AND t.data_deleted_at IS NULL)
     ORDER BY "cancellationRequestedAt"`,
  );
  return rows;
}

/**
 * Records that the provider has taken a cancelled business's number back, and that the business
 * has now left: status 'cancelled'. Audited. Call after the provider's release has succeeded.
 */
export async function recordNumberReleased(
  admin: AdminPool,
  tenantId: string,
  actorUserId: string,
): Promise<void> {
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    const released = await client.query<{ number: string; provider_sid: string }>(
      `UPDATE phone_numbers SET status = 'released', released_at = now()
       WHERE tenant_id = $1 AND status = 'active' RETURNING number, provider_sid`,
      [tenantId],
    );
    await client.query("UPDATE tenants SET status = 'cancelled' WHERE id = $1", [tenantId]);
    await client.query(
      "INSERT INTO audit_log (tenant_id, actor_user_id, action, details) VALUES ($1, $2, 'number.released', $3)",
      [
        tenantId,
        actorUserId,
        {
          via: "dashboard",
          number: released.rows[0]?.number ?? null,
          providerSid: released.rows[0]?.provider_sid ?? null,
        },
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Everything about a business that has to go at the providers, and where to confirm it. */
export interface DeletionPlan {
  status: string;
  dataDeletedAt: Date | null;
  businessName: string;
  notificationEmail: string | null;
  notificationMobile: string | null;
  /** Each call, so its data can be deleted where it's held. */
  calls: { providerCallId: string; viaFallback: boolean; recordingRef: string | null }[];
  /** The agents the business ever had at the voice platform. */
  agentIds: string[];
  /** The numbers it had, and when: call records at the telephony provider are by number. */
  numbers: { number: string; since: Date; until: Date | null }[];
  /** The texts we sent about it that the SMS provider still holds, by its reference. */
  messageRefs: string[];
  /** Logins at the login provider of the people whose only business this was. */
  logins: string[];
  /** The written confirmation already went (the audit log says so). */
  confirmationSent: boolean;
}

export async function deletionPlan(
  admin: AdminPool,
  tenantId: string,
): Promise<DeletionPlan | null> {
  const tenant = (
    await admin.query<{
      status: string;
      data_deleted_at: Date | null;
      business_name: string;
      notification_email: string | null;
      notification_mobile: string | null;
      confirmation_sent: boolean;
    }>(
      `SELECT status, data_deleted_at, business_name, notification_email, notification_mobile,
              EXISTS (SELECT 1 FROM audit_log a WHERE a.tenant_id = t.id
                      AND a.action = 'tenant.deletion-confirmed') AS confirmation_sent
       FROM tenants t WHERE id = $1`,
      [tenantId],
    )
  ).rows[0];
  if (!tenant) return null;
  const calls = await admin.query<{
    providerCallId: string;
    viaFallback: boolean;
    recordingRef: string | null;
  }>(
    `SELECT provider_call_id AS "providerCallId", via_fallback AS "viaFallback",
            recording_ref AS "recordingRef"
     FROM calls WHERE tenant_id = $1`,
    [tenantId],
  );
  const agents = await admin.query<{ id: string }>(
    "SELECT DISTINCT provider_agent_id AS id FROM agent_profiles WHERE tenant_id = $1 AND provider_agent_id IS NOT NULL",
    [tenantId],
  );
  const numbers = await admin.query<{ number: string; since: Date; until: Date | null }>(
    'SELECT number, created_at AS "since", released_at AS "until" FROM phone_numbers WHERE tenant_id = $1',
    [tenantId],
  );
  // Every text we sent about the business: call summaries, emergency texts (to callers too),
  // setup and leaving texts. Emails aren't here: Postmark keeps those for its retention period.
  const messages = await admin.query<{ ref: string }>(
    `SELECT provider_ref AS ref FROM notifications
       WHERE tenant_id = $1 AND channel <> 'email' AND provider_ref IS NOT NULL
     UNION SELECT provider_ref FROM onboarding_texts
       WHERE tenant_id = $1 AND provider_ref IS NOT NULL
     UNION SELECT provider_ref FROM offboarding_messages
       WHERE tenant_id = $1 AND channel = 'sms' AND provider_ref IS NOT NULL`,
    [tenantId],
  );
  // The people deleteTenantData anonymises (the same rule), where they have ever logged in.
  const logins = await admin.query<{ subject: string }>(
    `SELECT u.auth_subject AS subject FROM tenant_memberships m JOIN users u ON u.id = m.user_id
     WHERE m.tenant_id = $1 AND u.role = 'owner' AND u.auth_subject IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM tenant_memberships other
                       WHERE other.user_id = m.user_id AND other.tenant_id <> $1)`,
    [tenantId],
  );
  return {
    status: tenant.status,
    dataDeletedAt: tenant.data_deleted_at,
    businessName: tenant.business_name,
    notificationEmail: tenant.notification_email,
    notificationMobile: tenant.notification_mobile,
    calls: calls.rows,
    agentIds: agents.rows.map((row) => row.id),
    numbers: numbers.rows,
    messageRefs: messages.rows.map((row) => row.ref),
    logins: logins.rows.map((row) => row.subject),
    confirmationSent: tenant.confirmation_sent,
  };
}

/**
 * Deletes a business's data here (BUILD_PLAN Step 13), in one transaction, once the providers'
 * copies are gone. What goes: calls (with their costs and messages), the assistant's settings,
 * blocked numbers, onboarding and offboarding messages, memberships, and the people's login
 * details (their accounts are kept only as an anonymous reference for the terms record). What
 * stays: the business row, anonymised; the billing record (usage periods, each month's charge,
 * the Direct Debit's history and the payment provider's events, none of which holds personal
 * details); terms acceptances and the audit log, which are append-only records; and the numbers
 * it had, which are ours, not personal data.
 */
export async function deleteTenantData(
  admin: AdminPool,
  tenantId: string,
  {
    now,
    actorUserId,
    batchSize = RETENTION_BATCH_SIZE,
  }: { now: Date; actorUserId: string | null; batchSize?: number },
): Promise<{ calls: number }> {
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    // People whose only business this was: their accounts are anonymised, not deleted, because
    // the terms record refers to them.
    const people = await client.query<{ user_id: string }>(
      `SELECT m.user_id FROM tenant_memberships m JOIN users u ON u.id = m.user_id
       WHERE m.tenant_id = $1 AND u.role = 'owner'
         AND NOT EXISTS (SELECT 1 FROM tenant_memberships other
                         WHERE other.user_id = m.user_id AND other.tenant_id <> $1)`,
      [tenantId],
    );
    // The calls a batch at a time, still inside the one transaction: each DELETE (and the
    // costs and messages it cascades to) stays inside the statement timeout however many
    // calls the business took, where one statement over all of them would not.
    let calls = 0;
    for (;;) {
      const batch = await client.query(
        "DELETE FROM calls WHERE id IN (SELECT id FROM calls WHERE tenant_id = $1 LIMIT $2)",
        [tenantId, batchSize],
      );
      calls += batch.rowCount ?? 0;
      if ((batch.rowCount ?? 0) < batchSize) break;
    }
    for (const table of [
      "agent_profiles",
      "blocked_numbers",
      "onboarding_texts",
      "offboarding_messages",
      "tenant_memberships",
    ]) {
      await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
    }
    for (const { user_id: userId } of people.rows) {
      await client.query(
        "UPDATE users SET auth_subject = NULL, email = 'deleted-' || id || '@deleted.invalid' WHERE id = $1",
        [userId],
      );
    }
    await client.query(
      `UPDATE tenants SET business_name = 'Deleted business', contact_name = NULL,
              notification_mobile = NULL, notification_email = NULL, mobile_network = NULL,
              uses_network_voicemail = NULL, voicemail_restore_code = NULL, data_deleted_at = $2
       WHERE id = $1`,
      [tenantId, now],
    );
    await client.query(
      "INSERT INTO audit_log (tenant_id, actor_user_id, action, details) VALUES ($1, $2, 'tenant.data-deleted', $3)",
      [tenantId, actorUserId, { calls, people: people.rowCount ?? 0 }],
    );
    await client.query("COMMIT");
    return { calls };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// ─── People who log in (BUILD_PLAN Step 10) ────────────────────────────────────────────
// Creating accounts is an admin act (Step 11's onboarding invites owners; Phil and Ant are
// created once). Reading an account at login time goes through db/accounts.ts.

export interface NewUser {
  /**
   * The login provider's stable ID for the person (decision 012). Absent for an invitation:
   * the first login with the email fills it in.
   */
  authSubject?: string;
  email: string;
  role: "owner" | "admin" | "reseller";
}

export async function createUser(admin: AdminPool, user: NewUser): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    "INSERT INTO users (auth_subject, email, role) VALUES ($1, $2, $3) RETURNING id",
    [user.authSubject ?? null, user.email, user.role],
  );
  return rows[0]!.id;
}

export type InviteResult =
  { outcome: "invited"; userId: string } | { outcome: "exists"; role: string; userId: string };

/** Creates an account for someone who hasn't logged in yet, unless the address has one. */
export async function inviteUser(
  admin: AdminPool,
  user: Omit<NewUser, "authSubject">,
): Promise<InviteResult> {
  const existing = (
    await admin.query<{ id: string; role: string }>(
      "SELECT id, role FROM users WHERE lower(email) = lower($1)",
      [user.email],
    )
  ).rows[0];
  if (existing) return { outcome: "exists", role: existing.role, userId: existing.id };
  return { outcome: "invited", userId: await createUser(admin, user) };
}

// ─── Signup links (BUILD_PLAN Step 11) ─────────────────────────────────────────────────

export const SIGNUP_LINK_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Only a hash of a link's code is stored, so a copy of the table can't be used to sign up. */
function hashSignupCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/** Makes a single-use signup link's code (144 random bits), valid for 14 days. Audited. */
export async function createSignupLink(
  admin: AdminPool,
  link: { createdBy: string; forTest: boolean; now: Date },
): Promise<{ code: string; expiresAt: Date }> {
  const code = randomBytes(18).toString("base64url");
  const expiresAt = new Date(link.now.getTime() + SIGNUP_LINK_TTL_MS);
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO signup_links (code_hash, created_by, for_test, expires_at)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [hashSignupCode(code), link.createdBy, link.forTest, expiresAt],
  );
  await admin.query(
    "INSERT INTO audit_log (tenant_id, actor_user_id, action, details) VALUES (NULL, $1, 'signup-link.created', $2)",
    [link.createdBy, { linkId: rows[0]!.id, forTest: link.forTest }],
  );
  return { code, expiresAt };
}

export async function findSignupLink(
  admin: AdminPool,
  code: string,
): Promise<{ forTest: boolean; expiresAt: Date; usedAt: Date | null } | null> {
  const { rows } = await admin.query<{ forTest: boolean; expiresAt: Date; usedAt: Date | null }>(
    `SELECT for_test AS "forTest", expires_at AS "expiresAt", used_at AS "usedAt"
     FROM signup_links WHERE code_hash = $1`,
    [hashSignupCode(code)],
  );
  return rows[0] ?? null;
}

export type SignupOutcome =
  { outcome: "created"; tenantId: string; userId: string } | { outcome: "refused"; reason: string };

/**
 * Follows a signup link (BUILD_PLAN Step 11): creates the business, its owner account for the
 * person signed in, their membership, and an acceptance of each document at the version they
 * saw, then marks the link used. All in one transaction, with the link locked, so a link can
 * only ever make one business. The business starts at "terms accepted".
 */
export async function completeSignup(
  admin: AdminPool,
  signup: { input: SignupInput; subject: string; loginEmail: string; now: Date },
): Promise<SignupOutcome> {
  const { input, subject, loginEmail, now } = signup;
  const client = await admin.connect();
  let open = false;
  try {
    await client.query("BEGIN");
    open = true;
    const refuse = async (reason: string): Promise<SignupOutcome> => {
      await client.query("ROLLBACK");
      open = false;
      return { outcome: "refused", reason };
    };

    const link = (
      await client.query<{ id: string; for_test: boolean; expires_at: Date; used_at: Date | null }>(
        "SELECT id, for_test, expires_at, used_at FROM signup_links WHERE code_hash = $1 FOR UPDATE",
        [hashSignupCode(input.code)],
      )
    ).rows[0];
    if (!link) return await refuse("This signup link isn't valid");
    if (link.used_at) return await refuse("This signup link has already been used");
    if (link.expires_at <= now)
      return await refuse("This signup link has expired; ask for a new one");
    for (const type of LEGAL_DOCUMENT_TYPES) {
      if (input.accepted[type] !== LEGAL_DOCUMENTS[type].version) {
        return await refuse(
          "The documents have changed since this page opened. Reload it to see the current versions.",
        );
      }
    }
    const existing = await client.query(
      "SELECT 1 FROM users WHERE auth_subject = $1 OR lower(email) = lower($2)",
      [subject, loginEmail],
    );
    if (existing.rowCount !== 0) {
      return await refuse("You already have an AnswerMate account. Sign in to see it.");
    }

    const tenantId = (
      await client.query<{ id: string }>(
        `INSERT INTO tenants (business_name, trade, status, notification_mobile, notification_email,
                              contact_name, mobile_network, uses_network_voicemail, is_test,
                              onboarding_state)
         VALUES ($1, $2, 'onboarding', $3, $4, $5, $6, $7, $8, 'terms_accepted')
         RETURNING id`,
        [
          input.businessName,
          input.trade,
          input.mobile,
          input.email ?? loginEmail,
          input.contactName,
          input.mobileNetwork,
          input.usesNetworkVoicemail,
          link.for_test,
        ],
      )
    ).rows[0]!.id;
    let userId: string;
    try {
      userId = (
        await client.query<{ id: string }>(
          "INSERT INTO users (auth_subject, email, role) VALUES ($1, $2, 'owner') RETURNING id",
          [subject, loginEmail],
        )
      ).rows[0]!.id;
    } catch (error) {
      // The same person signing up through two links at once (two tabs, a double click): both
      // passed the check above before either had committed, and the other has now made the
      // account. The unique indexes stop a second one; this one gives way, as the check would.
      if ((error as { code?: unknown }).code === "23505") {
        return await refuse("You already have an AnswerMate account. Sign in to see it.");
      }
      throw error;
    }
    await client.query("INSERT INTO tenant_memberships (tenant_id, user_id) VALUES ($1, $2)", [
      tenantId,
      userId,
    ]);
    for (const type of LEGAL_DOCUMENT_TYPES) {
      await client.query(
        `INSERT INTO terms_acceptances (tenant_id, document_type, document_version, accepted_by, accepted_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [tenantId, type, input.accepted[type], userId, now],
      );
    }
    await client.query("UPDATE signup_links SET used_at = $2, tenant_id = $3 WHERE id = $1", [
      link.id,
      now,
      tenantId,
    ]);
    await client.query(
      `INSERT INTO audit_log (tenant_id, actor_user_id, action, details)
       VALUES ($1, $2, 'tenant.signed-up', $3), ($1, $2, 'onboarding.advanced', $4)`,
      [
        tenantId,
        userId,
        { via: "signup-link", linkId: link.id, forTest: link.for_test },
        { via: "signup-link", from: "created", to: "terms_accepted" },
      ],
    );
    await client.query("COMMIT");
    open = false;
    return { outcome: "created", tenantId, userId };
  } catch (error) {
    if (open) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Makes a user a member of a tenant. Owners see only the tenants they're members of. */
export async function addMembership(
  admin: AdminPool,
  tenantId: string,
  userId: string,
): Promise<void> {
  await admin.query(
    "INSERT INTO tenant_memberships (tenant_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [tenantId, userId],
  );
}

// ─── Retention (BUILD_PLAN Step 5) ─────────────────────────────────────────────────────
// Runs across every tenant, so it lives here with the other cross-tenant code.

export interface ExpiredRecording {
  tenantId: string;
  callId: string;
  providerCallId: string;
  recordingRef: string;
  viaFallback: boolean;
  /** Earlier runs that couldn't delete it. */
  attempts: number;
  /** Whether the alert that it looks stuck has been raised: it's said once per recording. */
  alerted: boolean;
}

/** How many recordings retention takes from the database at a time. */
export const RECORDING_BATCH_SIZE = 200;

/**
 * Calls whose recording is older than the retention period and not yet deleted: the ones no run
 * has failed on first, oldest first, then the ones that have failed least. Ordered by age alone,
 * recordings that can never be deleted stayed at the front for good, and a batch of them kept
 * every newer one waiting. `skip` leaves out the calls this run has already failed on, so the
 * next batch moves past them. The partial index on started_at (20261110120000) still finds the
 * rows: only the recordings past their 30 days are sorted, however big calls grows.
 */
export async function findExpiredRecordings(
  admin: AdminPool,
  olderThan: Date,
  { limit = RECORDING_BATCH_SIZE, skip = [] }: { limit?: number; skip?: readonly string[] } = {},
): Promise<ExpiredRecording[]> {
  const { rows } = await admin.query<ExpiredRecording>(
    `SELECT tenant_id AS "tenantId", id AS "callId", provider_call_id AS "providerCallId",
            recording_ref AS "recordingRef", via_fallback AS "viaFallback",
            recording_delete_attempts AS attempts,
            recording_delete_alerted_at IS NOT NULL AS alerted
     FROM calls
     WHERE recording_ref IS NOT NULL AND started_at < $1 AND NOT (id = ANY($3::uuid[]))
     ORDER BY recording_delete_attempts, started_at, id LIMIT $2`,
    [olderThan, limit, skip],
  );
  return rows;
}

/** Forgets a recording once the provider has deleted it. */
export async function clearRecording(admin: AdminPool, callId: string): Promise<void> {
  await admin.query("UPDATE calls SET recording_ref = NULL WHERE id = $1", [callId]);
}

/**
 * Counts a failed deletion against the call, and notes when the alert about it has been raised
 * (only ever set once: a later run leaves the first time as it was). Returns the new count.
 */
export async function recordRecordingDeleteFailure(
  admin: AdminPool,
  callId: string,
  { alertedAt }: { alertedAt: Date | null },
): Promise<number> {
  const { rows } = await admin.query<{ attempts: number }>(
    `UPDATE calls
     SET recording_delete_attempts = recording_delete_attempts + 1,
         recording_delete_alerted_at = COALESCE(recording_delete_alerted_at, $2)
     WHERE id = $1
     RETURNING recording_delete_attempts AS attempts`,
    [callId, alertedAt],
  );
  return rows[0]?.attempts ?? 0;
}

/** How many rows one retention statement touches: well inside the pool's 10-second statement timeout. */
export const RETENTION_BATCH_SIZE = 1000;
/** Batches one run clears at most: a backlog is worked off over a few nights, not in one. */
export const RETENTION_MAX_BATCHES = 100;

/**
 * Deletes transcripts, summaries and extracted fields older than the retention period, a
 * batch at a time: one statement over every old call would outgrow the statement timeout as
 * the table grows, and then fail every night without ever making progress. Returns the count.
 */
export async function clearExpiredTranscripts(
  admin: AdminPool,
  olderThan: Date,
  { batchSize = RETENTION_BATCH_SIZE, maxBatches = RETENTION_MAX_BATCHES } = {},
): Promise<number> {
  let cleared = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const result = await admin.query(
      `UPDATE calls SET transcript = NULL, summary = NULL, extracted_fields = '{}'
       WHERE id IN (
         SELECT id FROM calls
         WHERE started_at < $1 AND (transcript IS NOT NULL OR summary IS NOT NULL OR extracted_fields <> '{}')
         ORDER BY started_at
         LIMIT $2
       )`,
      [olderThan, batchSize],
    );
    cleared += result.rowCount ?? 0;
    if ((result.rowCount ?? 0) < batchSize) break;
  }
  return cleared;
}

/**
 * The latest agent profile version of each business that has an agent at the voice platform
 * (some version of its profile has synced): what the worker re-checks at start-up
 * (jobs/sync-agent.ts). The latest version may itself have failed to sync (a platform outage when
 * it was saved), and is tried again. Not a business that's never had an agent (one still
 * onboarding without a contact name would only fail again), nor one that's leaving or has left
 * (its calls hear "service has ended", never the agent).
 */
export async function listLatestProfilesWithLiveAgents(
  admin: AdminPool,
): Promise<{ tenantId: string; version: number }[]> {
  const { rows } = await admin.query<{ tenant_id: string; version: number }>(
    `SELECT DISTINCT ON (p.tenant_id) p.tenant_id, p.version
     FROM agent_profiles p JOIN tenants t ON t.id = p.tenant_id
     WHERE t.status NOT IN ('cancelling', 'cancelled')
       AND EXISTS (SELECT 1 FROM agent_profiles s
                   WHERE s.tenant_id = p.tenant_id AND s.synced_at IS NOT NULL)
     ORDER BY p.tenant_id, p.version DESC`,
  );
  return rows.map((row) => ({ tenantId: row.tenant_id, version: row.version }));
}

/** Of these provider call IDs, the ones whose call row exists and has ended (across tenants). */
export async function findCompletedProviderCallIds(
  admin: AdminPool,
  providerCallIds: string[],
): Promise<Set<string>> {
  if (providerCallIds.length === 0) return new Set();
  const { rows } = await admin.query<{ provider_call_id: string }>(
    "SELECT provider_call_id FROM calls WHERE provider_call_id = ANY($1) AND ended_at IS NOT NULL",
    [providerCallIds],
  );
  return new Set(rows.map((r) => r.provider_call_id));
}

/**
 * Makes a newly bought number the tenant's dedicated one, releasing their previous number
 * in our records, in one transaction: a tenant never ends up with no active number.
 */
export async function reassignNumber(
  admin: AdminPool,
  tenantId: string,
  number: string,
  providerSid: string,
): Promise<void> {
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE phone_numbers SET status = 'released', released_at = now() WHERE tenant_id = $1 AND status = 'active'",
      [tenantId],
    );
    await client.query(
      "INSERT INTO phone_numbers (tenant_id, number, provider_sid) VALUES ($1, $2, $3)",
      [tenantId, number, providerSid],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** The tenant's active number and its provider SID, or null if they have none. */
export async function activeNumberFor(
  admin: AdminPool,
  tenantId: string,
): Promise<{ number: string; providerSid: string } | null> {
  const { rows } = await admin.query<{ number: string; providerSid: string }>(
    `SELECT number, provider_sid AS "providerSid" FROM phone_numbers
     WHERE tenant_id = $1 AND status = 'active'`,
    [tenantId],
  );
  return rows[0] ?? null;
}

/** What the admin's Billing section shows (Step 12): money this month, and what needs a person. */
export interface BillingOverview {
  /** Since the start of this UK calendar month, by the day each charge was made. */
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
    /**
     * A failed payment GoCardless can be asked to retry, or a cancelled one a new payment can
     * be made for: only while the business has an active Direct Debit to make it against.
     */
    canCollectAgain: boolean;
  }[];
}

/** Statuses that need a person: the money didn't come, and won't by itself. */
const NEEDS_ATTENTION = ["failed", "cancelled", "charged_back", "no_mandate"];

export async function billingOverview(
  admin: AdminPool,
  monthStart: Date,
): Promise<BillingOverview> {
  const [totals, attention] = await Promise.all([
    admin.query<{ collected: number; collecting: number; problem: number }>(
      `SELECT
         COALESCE(sum(total_pence) FILTER (WHERE status IN ('confirmed', 'paid_out')), 0)::int AS collected,
         COALESCE(sum(total_pence) FILTER (WHERE status IN ('collecting', 'pending', 'submitted')), 0)::int AS collecting,
         COALESCE(sum(total_pence) FILTER (WHERE status = ANY($2)), 0)::int AS problem
       FROM billing_charges WHERE created_at >= $1`,
      [monthStart, NEEDS_ATTENTION],
    ),
    admin.query<BillingOverview["attention"][number]>(
      `SELECT b.id AS "chargeId", b.tenant_id AS "tenantId", t.business_name AS "businessName",
              b.period_start::text AS "periodStart", b.period_end::text AS "periodEnd",
              b.total_pence AS "totalPence", b.status, b.failure_reason AS "failureReason",
              (b.payment_ref IS NOT NULL AND (b.status = 'failed' OR (b.status = 'cancelled'
                 AND EXISTS (SELECT 1 FROM payment_mandates m
                             WHERE m.tenant_id = b.tenant_id AND m.status = 'active'))))
                AS "canCollectAgain"
       FROM billing_charges b JOIN tenants t ON t.id = b.tenant_id
       WHERE b.status = ANY($1)
       ORDER BY b.period_start DESC, t.business_name
       LIMIT 50`,
      [NEEDS_ATTENTION],
    ),
  ]);
  const row = totals.rows[0]!;
  return {
    thisMonth: {
      collectedPence: row.collected,
      collectingPence: row.collecting,
      problemPence: row.problem,
    },
    attention: attention.rows,
  };
}

/** Which business a charge belongs to, for the admin acting on it. A malformed ID is simply none. */
export async function tenantIdForCharge(
  admin: AdminPool,
  chargeId: string,
): Promise<string | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(chargeId))
    return null;
  const { rows } = await admin.query<{ tenant_id: string }>(
    "SELECT tenant_id FROM billing_charges WHERE id = $1",
    [chargeId],
  );
  return rows[0]?.tenant_id ?? null;
}

/**
 * What a business that's leaving still owes and hasn't paid yet (Step 13 with Step 12), in
 * words, or null when nothing is: every month it's charged for (those that began before it
 * asked to leave) has ended, been charged, and isn't still being collected. Its data, and so
 * its Direct Debit, waits until then: cancelling the Direct Debit would cancel a payment still
 * on its way. A month owed with no Direct Debit, or one whose payment failed, doesn't hold it
 * up: neither will arrive by Direct Debit.
 */
export async function billingStillOwed(
  admin: AdminPool,
  tenantId: string,
  today: string,
): Promise<string | null> {
  const tenant = (
    await admin.query<{
      billing_start_date: string | null;
      is_test: boolean;
      status: string;
      left_on: string | null;
    }>(
      `SELECT billing_start_date::text, is_test, status,
              to_char(cancellation_requested_at AT TIME ZONE 'Europe/London', 'YYYY-MM-DD') AS left_on
       FROM tenants WHERE id = $1`,
      [tenantId],
    )
  ).rows[0];
  if (!tenant || tenant.billing_start_date === null || tenant.is_test || tenant.status === "demo") {
    return null;
  }
  const leftOn = tenant.left_on ?? today;
  const farEnough = Temporal.PlainDate.from(leftOn).add({ months: 2 }).toString();
  const months = endedPeriods(tenant.billing_start_date, farEnough, leftOn);
  const last = months.at(-1);
  if (!last) return null;
  if (last.periodEnd > today) {
    return `its last month ends on ${last.periodEnd} and is charged that morning`;
  }
  const { rows } = await admin.query<{ period_start: string; status: string }>(
    "SELECT period_start::text, status FROM billing_charges WHERE tenant_id = $1",
    [tenantId],
  );
  const charged = new Map(rows.map((row) => [row.period_start, row.status]));
  const uncharged = months.find((month) => !charged.has(month.periodStart));
  if (uncharged) {
    return `the month from ${uncharged.periodStart} hasn't been charged yet (the 06:00 run does it)`;
  }
  const collecting = rows.find((row) =>
    ["collecting", "pending", "submitted"].includes(row.status),
  );
  if (collecting) {
    return `the payment for the month from ${collecting.period_start} is still being collected`;
  }
  return null;
}

export interface BillableTenant {
  tenantId: string;
  /** The UK date it went live: its billing months run from here. */
  billingStartDate: string;
  isPilot: boolean;
  /** The UK date it asked to leave, if it has: no month starting on or after it is charged. */
  leftOn: string | null;
}

/**
 * Every business that pays (decision 019): gone live, so it has a billing start date, and not
 * the demo line or a test business from a test link (Phil trying the service), which never pay.
 */
export async function listBillableTenants(admin: AdminPool): Promise<BillableTenant[]> {
  const { rows } = await admin.query<BillableTenant>(
    `SELECT id AS "tenantId", billing_start_date::text AS "billingStartDate", is_pilot AS "isPilot",
            to_char(cancellation_requested_at AT TIME ZONE 'Europe/London', 'YYYY-MM-DD') AS "leftOn"
     FROM tenants
     WHERE billing_start_date IS NOT NULL AND status <> 'demo' AND NOT is_test
     ORDER BY billing_start_date, id`,
  );
  return rows;
}

/**
 * The tenant a payments provider's reference belongs to (a Direct Debit set-up, a mandate, or
 * a payment), for its webhooks. Runs as the app role through a function that returns only the ID.
 */
export async function findTenantIdByPaymentRef(
  appPool: pg.Pool,
  ref: string,
): Promise<string | null> {
  const { rows } = await appPool.query<{ tenant_id: string | null }>(
    "SELECT tenant_id_for_payment_ref($1) AS tenant_id",
    [ref],
  );
  return rows[0]?.tenant_id ?? null;
}

/**
 * The tenant a message we sent belongs to, from the provider's message ID in a delivery
 * receipt: a call's text or email, an onboarding text, a cancellation notice, a billing email,
 * or a deletion's written confirmation (migration 20261111193000).
 */
export async function findTenantIdByProviderRef(
  appPool: pg.Pool,
  providerRef: string,
): Promise<string | null> {
  const { rows } = await appPool.query<{ tenant_id: string | null }>(
    "SELECT tenant_id_for_provider_ref($1) AS tenant_id",
    [providerRef],
  );
  return rows[0]?.tenant_id ?? null;
}
