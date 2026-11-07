import type { PgBoss } from "pg-boss";
import type pg from "pg";
import { billableSeconds, usagePeriodFor } from "../core/usage.ts";
import { EMERGENCY_PRIORITY, NOTIFY_EMERGENCY_QUEUE, PROCESS_CALL_QUEUE } from "../jobs/queue.ts";
import type { CallEndedEvent, FunctionCallEvent } from "../providers/voice.ts";
import { findTenantIdByNumber } from "./cross-tenant.ts";
import { withTenant } from "./tenant.ts";

export type RecordCallResult =
  | { outcome: "stored"; tenantId: string; callId: string; jobId: string | null }
  | { outcome: "duplicate"; tenantId: string }
  | { outcome: "unknown-number" };

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
        event.transcript.map((turn) => `${turn.role}: ${turn.text}`).join("\n"),
        event.recordingRef,
      ],
    );
    const callId = rows[0]?.id;
    if (callId === undefined) return { outcome: "duplicate", tenantId };

    // Billable seconds accumulate per period; overage is worked out once per period (Step 12).
    if (billable > 0) {
      const { periodStart, periodEnd } = usagePeriodFor(event.startedAt);
      await client.query(
        `INSERT INTO usage_periods (tenant_id, period_start, period_end, billable_seconds)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, period_start)
         DO UPDATE SET billable_seconds = usage_periods.billable_seconds + EXCLUDED.billable_seconds`,
        [tenantId, periodStart, periodEnd, billable],
      );
    }

    for (const cost of event.costs) {
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
  const kind = EMERGENCY_FUNCTION_KINDS[event.name];
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
        priority: EMERGENCY_PRIORITY,
        db: { executeSql: (text: string, values?: unknown[]) => client.query(text, values) },
      },
    );
    return { outcome: "alerted", tenantId, callId, kind };
  });
}
