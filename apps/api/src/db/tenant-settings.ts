// The tenant's own settings from the dashboard (BUILD_PLAN Step 10): where notifications go,
// and asking to leave. Each write is audited with the person behind it. The audit details
// name which fields changed, never the values: the audit log stays free of contact details.
import type pg from "pg";
import {
  notificationSettingsSchema,
  type CsvExport,
  type NotificationSettings,
  type TenantStatus,
} from "@callmate/shared";
import type { EnqueueOffboarding } from "../jobs/offboarding.ts";
import { toCsv } from "../core/csv.ts";
import { withTenant } from "./tenant.ts";

// The rules live in packages/shared/src/settings.ts, so the dashboard checks them too.
export { notificationSettingsSchema, type NotificationSettings };

export async function updateNotificationSettings(
  pool: pg.Pool,
  tenantId: string,
  settings: NotificationSettings,
  actorUserId: string,
): Promise<NotificationSettings> {
  const parsed = notificationSettingsSchema.parse(settings);
  return withTenant(pool, tenantId, async (client) => {
    const before = (
      await client.query<{ notification_mobile: string | null; notification_email: string | null }>(
        "SELECT notification_mobile, notification_email FROM tenants WHERE id = $1 FOR UPDATE",
        [tenantId],
      )
    ).rows[0];
    if (!before) throw new Error(`Tenant ${tenantId} not found`);
    const changed = [
      ...(before.notification_mobile !== parsed.notificationMobile ? ["notificationMobile"] : []),
      ...(before.notification_email !== parsed.notificationEmail ? ["notificationEmail"] : []),
    ];
    if (changed.length > 0) {
      await client.query(
        "UPDATE tenants SET notification_mobile = $2, notification_email = $3 WHERE id = $1",
        [tenantId, parsed.notificationMobile, parsed.notificationEmail],
      );
      await client.query(
        "INSERT INTO audit_log (tenant_id, actor_user_id, action, details) VALUES ($1, $2, 'notifications.changed', $3)",
        [tenantId, actorUserId, { via: "dashboard", changed }],
      );
    }
    return parsed;
  });
}

export type CancellationResult =
  | { outcome: "cancelling"; status: "cancelling" }
  /** Already on the way out, or never live: nothing to cancel from here. */
  | { outcome: "not-allowed"; status: TenantStatus };

/**
 * Starts leaving. From now on callers hear the "service has ended" message (core/routing.ts),
 * the tradesperson is texted and emailed how to remove their divert, and after 30 days an admin
 * can release the number (BUILD_PLAN Step 13).
 */
export async function requestCancellation(
  pool: pg.Pool,
  tenantId: string,
  actorUserId: string,
  options: { now: Date; enqueueOffboarding?: EnqueueOffboarding },
): Promise<CancellationResult> {
  return withTenant(pool, tenantId, async (client) => {
    const row = (
      await client.query<{ status: TenantStatus }>(
        "SELECT status FROM tenants WHERE id = $1 FOR UPDATE",
        [tenantId],
      )
    ).rows[0];
    if (!row) throw new Error(`Tenant ${tenantId} not found`);
    if (row.status !== "live" && row.status !== "paused") {
      return { outcome: "not-allowed", status: row.status };
    }
    // The 30 days of "service has ended" count from now (core/offboarding.ts).
    await client.query(
      "UPDATE tenants SET status = 'cancelling', cancellation_requested_at = $2 WHERE id = $1",
      [tenantId, options.now],
    );
    // The text and email about removing the divert, committed with the cancellation.
    await options.enqueueOffboarding?.({ tenantId, action: "cancellation-notices" }, client);
    await client.query(
      "INSERT INTO audit_log (tenant_id, actor_user_id, action, details) VALUES ($1, $2, 'tenant.cancel-requested', $3)",
      [tenantId, actorUserId, { via: "dashboard", from: row.status }],
    );
    return { outcome: "cancelling", status: "cancelling" };
  });
}

/** Everything we hold for one tenant, for the data export. RLS guarantees it's only theirs. */
export async function exportTenant(pool: pg.Pool, tenantId: string) {
  return withTenant(pool, tenantId, async (client) => {
    // One after another: a connection runs one query at a time, and handing it several at once
    // is deprecated in pg (removed in pg 9). They share the transaction, so they see one snapshot.
    const tenant = await client.query("SELECT * FROM tenants WHERE id = $1", [tenantId]);
    const profiles = await client.query(
      `SELECT version, trade_template, services, service_areas, opening_hours, holiday_mode,
              holiday_until, faqs, emergency_policy, synced_at, sync_error, created_at
       FROM agent_profiles WHERE tenant_id = $1 ORDER BY version`,
      [tenantId],
    );
    const calls = await client.query(
      `SELECT id, caller_number, started_at, ended_at, billable_seconds, outcome, urgency, summary,
              extracted_fields, transcript, via_fallback, flags, created_at
       FROM calls WHERE tenant_id = $1 ORDER BY started_at`,
      [tenantId],
    );
    const notifications = await client.query(
      `SELECT call_id, channel, status, attempts, failure_code, created_at, updated_at
       FROM notifications WHERE tenant_id = $1 ORDER BY created_at`,
      [tenantId],
    );
    const audit = await client.query(
      "SELECT action, details, created_at FROM audit_log WHERE tenant_id = $1 ORDER BY created_at",
      [tenantId],
    );
    const numbers = await client.query(
      "SELECT number, status, created_at, released_at FROM phone_numbers WHERE tenant_id = $1 ORDER BY created_at",
      [tenantId],
    );
    const terms = await client.query(
      "SELECT document_type, document_version, accepted_at FROM terms_acceptances WHERE tenant_id = $1 ORDER BY accepted_at",
      [tenantId],
    );
    // Dates as text: pg would turn a date into a Date at local midnight, a day out in BST.
    const usage = await client.query(
      `SELECT to_char(period_start, 'YYYY-MM-DD') AS period_start,
              to_char(period_end, 'YYYY-MM-DD') AS period_end, billable_seconds
       FROM usage_periods WHERE tenant_id = $1 ORDER BY period_start`,
      [tenantId],
    );
    const blocked = await client.query(
      "SELECT number, reason, created_at FROM blocked_numbers WHERE tenant_id = $1 ORDER BY created_at",
      [tenantId],
    );
    const setupTexts = await client.query(
      "SELECT kind, status, created_at FROM onboarding_texts WHERE tenant_id = $1 ORDER BY created_at",
      [tenantId],
    );
    const leavingMessages = await client.query(
      "SELECT kind, channel, status, created_at FROM offboarding_messages WHERE tenant_id = $1 ORDER BY created_at",
      [tenantId],
    );
    // Billing (Step 12): each month's charge with its lines, and each Direct Debit set up. The
    // provider's references are ours to look things up by; bank details never reach us.
    const charges = await client.query(
      `SELECT to_char(period_start, 'YYYY-MM-DD') AS period_start,
              to_char(period_end, 'YYYY-MM-DD') AS period_end, billable_seconds, fee_pence,
              overage_minutes, overage_pence, vat_rate_percent, vat_pence, total_pence, vat_number,
              lines, status, to_char(charge_date, 'YYYY-MM-DD') AS charge_date, failure_reason,
              created_at
       FROM billing_charges WHERE tenant_id = $1 ORDER BY period_start`,
      [tenantId],
    );
    const directDebits = await client.query(
      `SELECT status, end_reason, activated_at, ended_at, created_at
       FROM payment_mandates WHERE tenant_id = $1 ORDER BY created_at`,
      [tenantId],
    );
    return {
      exportedAt: new Date().toISOString(),
      tenant: (tenant.rows[0] as Record<string, unknown> | undefined) ?? null,
      agentProfiles: profiles.rows,
      calls: calls.rows,
      notifications: notifications.rows,
      auditLog: audit.rows,
      phoneNumbers: numbers.rows,
      termsAcceptances: terms.rows,
      usagePeriods: usage.rows,
      blockedNumbers: blocked.rows,
      onboardingTexts: setupTexts.rows,
      offboardingMessages: leavingMessages.rows,
      billingCharges: charges.rows,
      directDebits: directDebits.rows,
    };
  });
}

/** Each CSV table (BUILD_PLAN Step 13), as a spreadsheet would want it. */
const CSV_QUERIES: Record<CsvExport, { header: string[]; sql: string }> = {
  business: {
    header: [
      "business_name",
      "trade",
      "contact_name",
      "notification_mobile",
      "notification_email",
      "mobile_network",
      "status",
      "onboarding_state",
      "created_at",
      "cancellation_requested_at",
    ],
    sql: `SELECT business_name, trade, contact_name, notification_mobile, notification_email,
                 mobile_network, status, onboarding_state, created_at, cancellation_requested_at
          FROM tenants WHERE id = $1`,
  },
  calls: {
    header: [
      "started_at",
      "ended_at",
      "caller_number",
      "caller_name",
      "callback_number",
      "postcode",
      "urgency",
      "summary",
      "voicemail",
      "flags",
      "transcript",
    ],
    sql: `SELECT started_at, ended_at, caller_number, extracted_fields->>'callerName',
                 extracted_fields->>'callbackNumber', extracted_fields->>'postcode', urgency,
                 summary, via_fallback, array_to_string(flags, '; '), transcript
          FROM calls WHERE tenant_id = $1 ORDER BY started_at`,
  },
  messages: {
    header: ["created_at", "call_started_at", "channel", "status", "attempts", "failure_code"],
    sql: `SELECT n.created_at, c.started_at, n.channel, n.status, n.attempts, n.failure_code
          FROM notifications n JOIN calls c ON c.id = n.call_id
          WHERE n.tenant_id = $1 ORDER BY n.created_at`,
  },
  assistant: {
    header: [
      "version",
      "saved_at",
      "trade",
      "services",
      "service_areas",
      "opening_hours",
      "holiday_mode",
      "holiday_until",
      "faqs",
      "takes_urgent_call_outs",
      "live_since",
    ],
    sql: `SELECT version, created_at, trade_template,
                 (SELECT string_agg(value, '; ') FROM jsonb_array_elements_text(services)),
                 (SELECT string_agg(value, '; ') FROM jsonb_array_elements_text(service_areas)),
                 opening_hours, holiday_mode, to_char(holiday_until, 'YYYY-MM-DD'), faqs,
                 emergency_policy->'takesEmergencyCalls', synced_at
          FROM agent_profiles WHERE tenant_id = $1 ORDER BY version`,
  },
  "account-log": {
    header: ["at", "action", "details"],
    sql: "SELECT created_at, action, details FROM audit_log WHERE tenant_id = $1 ORDER BY created_at",
  },
  // Money as pounds and pence for a spreadsheet; the pence are exact, so the text is too.
  billing: {
    header: [
      "month_from",
      "month_to",
      "billable_minutes",
      "fee",
      "overage",
      "vat",
      "total",
      "status",
      "collected_from",
    ],
    sql: `SELECT to_char(period_start, 'YYYY-MM-DD'), to_char(period_end - 1, 'YYYY-MM-DD'),
                 ceil(billable_seconds / 60.0)::int,
                 to_char(fee_pence / 100.0, 'FM999990.00'),
                 to_char(overage_pence / 100.0, 'FM999990.00'),
                 to_char(vat_pence / 100.0, 'FM999990.00'),
                 to_char(total_pence / 100.0, 'FM999990.00'),
                 status, to_char(charge_date, 'YYYY-MM-DD')
          FROM billing_charges WHERE tenant_id = $1 ORDER BY period_start`,
  },
};

/** One table of the business's data as CSV. Row-level security keeps it to that business. */
export async function exportTenantCsv(
  pool: pg.Pool,
  tenantId: string,
  table: CsvExport,
): Promise<string> {
  const { header, sql } = CSV_QUERIES[table];
  const result = await withTenant(pool, tenantId, (client) =>
    client.query<unknown[]>({ text: sql, values: [tenantId], rowMode: "array" }),
  );
  return toCsv(header, result.rows);
}
