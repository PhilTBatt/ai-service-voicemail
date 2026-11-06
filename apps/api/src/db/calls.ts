import type { PgBoss } from "pg-boss";
import type pg from "pg";
import { billableSeconds, usagePeriodFor } from "../core/usage.ts";
import { PROCESS_CALL_QUEUE } from "../jobs/queue.ts";
import type { CallEndedEvent } from "../providers/voice.ts";
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
       ON CONFLICT (provider_call_id) DO NOTHING
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
