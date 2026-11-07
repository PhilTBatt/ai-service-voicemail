import type pg from "pg";
import type { EnqueueNotifications } from "../jobs/enqueue-notifications.ts";
import { findTenantIdByNumber } from "./cross-tenant.ts";
import { withTenant } from "./tenant.ts";

export interface FallbackVoicemail {
  /** Twilio's CallSid: the call's provider ID, unique across every tenant. */
  callSid: string;
  from: string | null;
  to: string;
  recordingUrl: string;
  durationSeconds: number;
  startedAt: Date;
  endedAt: Date | null;
}

export type StoreVoicemailResult =
  | { outcome: "stored" | "duplicate"; tenantId: string }
  | { outcome: "unknown-number"; tenantId: null };

/**
 * Records a fallback voicemail as a call row for the tenant of the dialled number. Safe to
 * repeat: the callback and the reconciliation job can both see the same recording, and the
 * unique provider_call_id makes the second attempt a no-op.
 */
export async function storeFallbackVoicemail(
  pool: pg.Pool,
  voicemail: FallbackVoicemail,
  enqueueNotifications?: EnqueueNotifications,
): Promise<StoreVoicemailResult> {
  const tenantId = await findTenantIdByNumber(pool, voicemail.to);
  if (tenantId === null) return { outcome: "unknown-number", tenantId: null };

  const inserted = await withTenant(pool, tenantId, async (client) => {
    const result = await client.query<{ id: string }>(
      // A fallback voicemail is our failure mode, so it's never billed (billable_seconds 0);
      // the recording's length lives with the call for the texts and the call page.
      `INSERT INTO calls (tenant_id, provider_call_id, caller_number, started_at, ended_at,
                          billable_seconds, outcome, recording_ref, via_fallback, extracted_fields)
       VALUES ($1, $2, $3, $4, $5, 0, 'voicemail', $6, true, $7)
       ON CONFLICT (provider_call_id) DO NOTHING
       RETURNING id`,
      [
        tenantId,
        voicemail.callSid,
        voicemail.from,
        voicemail.startedAt,
        voicemail.endedAt,
        voicemail.recordingUrl,
        JSON.stringify({ recordingSeconds: voicemail.durationSeconds }),
      ],
    );
    const callId = result.rows[0]?.id;
    if (callId === undefined) return false;
    // The "new voicemail" text, committed with the row (BUILD_PLAN Step 6).
    await enqueueNotifications?.(client, { tenantId, callId, urgency: null });
    return true;
  });
  return { outcome: inserted ? "stored" : "duplicate", tenantId };
}
