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
import type { CostPrices } from "../core/prices.ts";
import { createPool } from "./pool.ts";

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
export function createAdminPool(adminDatabaseUrl: string): AdminPool {
  return createPool(adminDatabaseUrl) as AdminPool;
}

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
}

/** Every tenant with its call counts. Counts are safe for the reseller; nothing else here is content. */
export async function listTenantsWithCallCounts(admin: AdminPool): Promise<TenantWithCallCounts[]> {
  const { rows } = await admin.query<TenantWithCallCounts>(
    `SELECT t.id, t.business_name AS "businessName", t.trade, t.status,
            t.onboarding_state AS "onboardingState", t.created_at AS "createdAt",
            COUNT(c.id) FILTER (WHERE c.started_at >= now() - interval '30 days')::int AS "callsLast30Days",
            COUNT(c.id)::int AS "callsTotal"
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
}

export async function healthSnapshot(admin: AdminPool, since: Date): Promise<HealthSnapshot> {
  const [counts, syncs] = await Promise.all([
    admin.query<{ kill_switch_on: boolean; fallback_calls: number; failed_notifications: number }>(
      `SELECT (SELECT kill_switch_on FROM system_settings) AS kill_switch_on,
              (SELECT count(*) FROM calls WHERE via_fallback AND started_at >= $1)::int AS fallback_calls,
              (SELECT count(*) FROM notifications
                WHERE status IN ('failed', 'undelivered') AND updated_at >= $1)::int AS failed_notifications`,
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
  ]);
  const row = counts.rows[0]!;
  return {
    killSwitchOn: row.kill_switch_on,
    fallbackCalls: row.fallback_calls,
    failedNotifications: row.failed_notifications,
    failedSyncs: syncs.rows,
  };
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

/** A flagged call with the tenant it belongs to, for the admin's review queue. */
export type FlaggedCall = import("../routes/call-view.ts").CallRow & {
  tenant: { id: string; businessName: string };
};

export async function listFlaggedCalls(admin: AdminPool, limit: number): Promise<FlaggedCall[]> {
  const { rows } = await admin.query<
    import("../routes/call-view.ts").CallRow & { tenant_id: string; business_name: string }
  >(
    `SELECT c.id, c.provider_call_id, c.started_at, c.ended_at, c.billable_seconds, c.caller_number,
            c.urgency, c.summary, c.flags, c.extracted_fields, c.transcript, c.recording_ref,
            c.via_fallback, c.tenant_id, t.business_name
     FROM calls c JOIN tenants t ON t.id = c.tenant_id
     WHERE cardinality(c.flags) > 0
     ORDER BY c.started_at DESC, c.id DESC
     LIMIT $1`,
    [limit],
  );
  return rows.map(({ tenant_id, business_name, ...call }) => ({
    ...call,
    tenant: { id: tenant_id, businessName: business_name },
  }));
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

/** Every tenant's billable seconds and call count for the period containing `today`. */
export async function listCurrentUsage(admin: AdminPool, today: Date): Promise<TenantUsage[]> {
  const { rows } = await admin.query<TenantUsage>(
    `SELECT t.id AS "tenantId", t.business_name AS "businessName", t.status,
            to_char(u.period_start, 'YYYY-MM-DD') AS "periodStart",
            to_char(u.period_end, 'YYYY-MM-DD') AS "periodEnd",
            COALESCE(u.billable_seconds, 0)::int AS "billableSeconds",
            (SELECT count(*) FROM calls c
              WHERE c.tenant_id = t.id
                AND c.started_at >= COALESCE(u.period_start, date_trunc('month', $1::timestamptz)::date)
                AND c.started_at < COALESCE(u.period_end, (date_trunc('month', $1::timestamptz) + interval '1 month')::date)
            )::int AS calls
     FROM tenants t
     LEFT JOIN usage_periods u
       ON u.tenant_id = t.id AND u.period_start <= $1::date AND u.period_end > $1::date
     ORDER BY t.business_name`,
    [today],
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
            THEN round($7::numeric * 100)::int ELSE 0 END AS number
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
        total: row.voice_platform + row.language_model + row.texts + row.phone_minutes + row.number,
      },
    })),
    unpriced: unpriced.rows.map((row) => row.component),
  };
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
  { outcome: "invited"; userId: string } | { outcome: "exists"; role: string };

/** Creates an account for someone who hasn't logged in yet, unless the address has one. */
export async function inviteUser(
  admin: AdminPool,
  user: Omit<NewUser, "authSubject">,
): Promise<InviteResult> {
  const existing = (
    await admin.query<{ role: string }>("SELECT role FROM users WHERE lower(email) = lower($1)", [
      user.email,
    ])
  ).rows[0];
  if (existing) return { outcome: "exists", role: existing.role };
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
    const userId = (
      await client.query<{ id: string }>(
        "INSERT INTO users (auth_subject, email, role) VALUES ($1, $2, 'owner') RETURNING id",
        [subject, loginEmail],
      )
    ).rows[0]!.id;
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
}

/** Calls whose recording is older than the retention period and not yet deleted. */
export async function findExpiredRecordings(
  admin: AdminPool,
  olderThan: Date,
  limit = 200,
): Promise<ExpiredRecording[]> {
  const { rows } = await admin.query<ExpiredRecording>(
    `SELECT tenant_id AS "tenantId", id AS "callId", provider_call_id AS "providerCallId",
            recording_ref AS "recordingRef", via_fallback AS "viaFallback"
     FROM calls WHERE recording_ref IS NOT NULL AND started_at < $1
     ORDER BY started_at LIMIT $2`,
    [olderThan, limit],
  );
  return rows;
}

/** Forgets a recording once the provider has deleted it. */
export async function clearRecording(admin: AdminPool, callId: string): Promise<void> {
  await admin.query("UPDATE calls SET recording_ref = NULL WHERE id = $1", [callId]);
}

/** Deletes transcripts, summaries and extracted fields older than the retention period. Returns the count. */
export async function clearExpiredTranscripts(admin: AdminPool, olderThan: Date): Promise<number> {
  const result = await admin.query(
    `UPDATE calls SET transcript = NULL, summary = NULL, extracted_fields = '{}'
     WHERE started_at < $1 AND (transcript IS NOT NULL OR summary IS NOT NULL OR extracted_fields <> '{}')`,
    [olderThan],
  );
  return result.rowCount ?? 0;
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

/** The tenant a notification belongs to, from the provider's message ID in a delivery receipt. */
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
