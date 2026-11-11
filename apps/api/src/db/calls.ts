import type { PgBoss } from "pg-boss";
import { enqueueOnboardingWith } from "../jobs/onboarding.ts";
import { noteTestCall } from "./onboarding.ts";
import type pg from "pg";
import { ukDateOf } from "../core/billing.ts";
import { billableSeconds, usagePeriodFor } from "../core/usage.ts";
import { NOTIFY_EMERGENCY_QUEUE, PROCESS_CALL_QUEUE } from "../jobs/queue.ts";
import { logger } from "../logger.ts";
import type { CallEndedEvent, FunctionCallEvent } from "../providers/voice.ts";
import { findTenantIdByNumber } from "./cross-tenant.ts";
import { withTenant } from "./tenant.ts";

export type RecordCallResult =
  | { outcome: "stored"; tenantId: string; callId: string; jobId: string | null }
  | { outcome: "duplicate"; tenantId: string }
  | { outcome: "unknown-number" };

/** call_costs.units is numeric(14, 4): under 10 billion, and checked never to be negative. */
const MAX_COST_UNITS = 9_999_999_999;

/** Why call_costs would refuse this line, or null when it can be stored. */
function unstorableCost(cost: CallEndedEvent["costs"][number]): string | null {
  if (!Number.isFinite(cost.units)) return "not a number";
  if (cost.units < 0) return "negative";
  if (cost.units > MAX_COST_UNITS) return "too large";
  // Postgres text can't hold a NUL character.
  if (cost.component.includes("\u0000") || cost.unitType.includes("\u0000")) return "NUL character";
  return null;
}

/**
 * Stores a finished call and queues its processing, in ONE transaction: either the call row,
 * its cost rows and the process-call job all exist, or none do. A duplicate webhook (the
 * platform retries on timeouts) hits the unique provider_call_id and does nothing at all.
 * Everything slow happens in the worker; this must return fast.
 */
export async function recordCallEnded(
  pool: pg.Pool,
  boss: PgBoss,
  event: CallEndedEvent,
): Promise<RecordCallResult> {
  const tenantId = await findTenantIdByNumber(pool, event.dialledNumber);
  if (tenantId === null) return { outcome: "unknown-number" };

  return withTenant(pool, tenantId, async (client) => {
    const billable = billableSeconds(event.durationSeconds);
    const tenant = (
      await client.query<{ status: string; billing_start_date: string | null }>(
        "SELECT status, billing_start_date::text FROM tenants WHERE id = $1",
        [tenantId],
      )
    ).rows[0];
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO calls (tenant_id, provider_call_id, caller_number, started_at, ended_at,
                          billable_seconds, outcome, transcript, recording_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (provider_call_id) DO UPDATE
         SET caller_number = COALESCE(EXCLUDED.caller_number, calls.caller_number),
             started_at = EXCLUDED.started_at,
             ended_at = EXCLUDED.ended_at,
             billable_seconds = EXCLUDED.billable_seconds,
             outcome = EXCLUDED.outcome,
             transcript = EXCLUDED.transcript,
             recording_ref = EXCLUDED.recording_ref
         -- Only a provisional row opened mid-call (recordMidCallEmergency) is completed here.
         -- A row that already ended is a repeated webhook, and nothing is returned for it.
         WHERE calls.ended_at IS NULL
       RETURNING id`,
      [
        tenantId,
        event.providerCallId,
        event.callerNumber,
        event.startedAt,
        event.endedAt,
        billable,
        event.endReason,
        // One line per turn. A newline inside a turn would make its tail look like the other
        // speaker's line when parsed back, so it's folded into a space. A NUL character (valid
        // JSON, but Postgres text can't hold it) is dropped: otherwise the insert fails, and
        // the call is lost on every redelivery and every reconciliation run.
        event.transcript
          .map(
            (turn) =>
              `${turn.role}: ${turn.text.replaceAll("\u0000", "").replaceAll(/\s*\n\s*/g, " ")}`,
          )
          .join("\n"),
        event.recordingRef,
      ],
    );
    const callId = rows[0]?.id;
    if (callId === undefined) return { outcome: "duplicate", tenantId };
    if (await noteTestCall(client, tenantId)) {
      await enqueueOnboardingWith(boss)({ tenantId, action: "go-live" }, client);
    }

    // Billable seconds accumulate per period; overage is worked out once per period (Step 12).
    // Periods are months from the day the business went live (decision 019), and only calls
    // from that day on count: the test call, and anything else before going live, is never
    // billed (Step 12), nor are the demo line's calls (Step 9). Their costs still land in
    // call_costs, on the business's own line.
    const billingStart = tenant?.billing_start_date ?? null;
    if (
      billable > 0 &&
      tenant?.status !== "demo" &&
      billingStart !== null &&
      ukDateOf(event.startedAt) >= billingStart
    ) {
      const { periodStart, periodEnd } = usagePeriodFor(event.startedAt, billingStart);
      await client.query(
        `INSERT INTO usage_periods (tenant_id, period_start, period_end, billable_seconds)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, period_start)
         DO UPDATE SET billable_seconds = usage_periods.billable_seconds + EXCLUDED.billable_seconds`,
        [tenantId, periodStart, periodEnd, billable],
      );
    }

    for (const cost of event.costs) {
      // A call must never be lost over a cost line. One the table can't hold (Retell has sent a
      // negative product cost) failed the insert, and so the whole call, on every redelivery
      // and every reconciliation run. It's left out, with a warning that names no one.
      const unstorable = unstorableCost(cost);
      if (unstorable !== null) {
        logger.warn("Cost line the database can't hold: left out, the call stored", {
          tenantId,
          callId,
          component: cost.component.replaceAll("\u0000", "").slice(0, 80),
          reason: unstorable,
        });
        continue;
      }
      await client.query(
        `INSERT INTO call_costs (tenant_id, call_id, component, units, unit_type, is_estimated)
         VALUES ($1, $2, $3, $4, $5, false)`,
        [tenantId, callId, cost.component, cost.units, cost.unitType],
      );
    }

    // pg-boss writes the job through our transaction's client, so it commits (or rolls
    // back) with the call row. The provider's call ID is the idempotency key.
    const jobId = await boss.send(
      PROCESS_CALL_QUEUE,
      { tenantId, callId, providerCallId: event.providerCallId },
      {
        singletonKey: event.providerCallId,
        db: { executeSql: (text: string, values?: unknown[]) => client.query(text, values) },
      },
    );
    return { outcome: "stored", tenantId, callId, jobId };
  });
}

/** The mid-call functions that mean an emergency. Names match the Retell flow's tools. */
export const EMERGENCY_FUNCTION_KINDS: Record<string, "gas" | "danger"> = {
  gas_emergency_alert: "gas",
  danger_alert: "danger",
};

export type MidCallEmergencyResult =
  | { outcome: "alerted"; tenantId: string; callId: string; kind: "gas" | "danger" }
  | { outcome: "unknown-number" }
  | { outcome: "not-an-emergency-function"; name: string };

/**
 * The call is still going and the agent has just spoken an emergency script. Opens a
 * provisional call row (recordCallEnded completes it when the call ends) and queues the
 * emergency texts, in one transaction. Idempotent: the platform may retry the request,
 * and the same call may trigger more than one script.
 */
export async function recordMidCallEmergency(
  pool: pg.Pool,
  boss: PgBoss,
  event: FunctionCallEvent,
  now: () => Date = () => new Date(),
): Promise<MidCallEmergencyResult> {
  // Own keys only: a name such as "constructor" or "__proto__" would otherwise find Object's
  // own properties and be taken for an emergency kind.
  const kind = Object.hasOwn(EMERGENCY_FUNCTION_KINDS, event.name)
    ? EMERGENCY_FUNCTION_KINDS[event.name]
    : undefined;
  if (!kind) return { outcome: "not-an-emergency-function", name: event.name };
  if (event.dialledNumber === null) return { outcome: "unknown-number" };
  const tenantId = await findTenantIdByNumber(pool, event.dialledNumber);
  if (tenantId === null) return { outcome: "unknown-number" };

  return withTenant(pool, tenantId, async (client) => {
    const flag = `emergency:${kind}`;
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO calls (tenant_id, provider_call_id, caller_number, started_at, urgency, flags)
       VALUES ($1, $2, $3, $4, 'emergency', ARRAY[$5::text])
       ON CONFLICT (provider_call_id) DO UPDATE
         SET urgency = 'emergency',
             flags = CASE WHEN calls.flags @> ARRAY[$5::text] THEN calls.flags
                          ELSE calls.flags || $5::text END
       RETURNING id`,
      [tenantId, event.providerCallId, event.callerNumber, now(), flag],
    );
    const callId = rows[0]!.id;
    // One emergency job per call at a time (exclusive queue); a retry while it's queued is dropped.
    await boss.send(
      NOTIFY_EMERGENCY_QUEUE,
      { tenantId, callId, kind },
      {
        singletonKey: callId,
        db: { executeSql: (text: string, values?: unknown[]) => client.query(text, values) },
      },
    );
    return { outcome: "alerted", tenantId, callId, kind };
  });
}
