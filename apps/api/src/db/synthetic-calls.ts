// What the database shows for a synthetic call (BUILD_PLAN Step 14), for the checker in
// core/synthetic-calls.ts to judge. Read as the test business, through row-level security like
// any tenant read: the checker needs nothing from any other business.
import type { Urgency } from "@callmate/shared";
import type pg from "pg";
import type { ObservedCall } from "../core/synthetic-calls.ts";
import type { NotificationChannel, NotificationStatus } from "../jobs/deliver-notification.ts";
import { withTenant } from "./tenant.ts";

/**
 * The first call from `callerNumber` to the business since the synthetic call was placed, and
 * its messages. A minute's grace on the start time: the voice platform stamps it, not us.
 */
export function observeSyntheticCall(
  pool: pg.Pool,
  tenantId: string,
  { callerNumber, placedAt }: { callerNumber: string; placedAt: Date },
): Promise<ObservedCall> {
  return withTenant(pool, tenantId, async (client) => {
    const call = (
      await client.query<{
        id: string;
        ended_at: Date | null;
        urgency: Urgency | null;
        processed: boolean;
      }>(
        `SELECT id, ended_at, urgency, summary IS NOT NULL AS processed FROM calls
         WHERE tenant_id = $1 AND caller_number = $2
           AND started_at >= $3::timestamptz - interval '1 minute'
         ORDER BY started_at LIMIT 1`,
        [tenantId, callerNumber, placedAt],
      )
    ).rows[0];
    if (!call) return { call: null, notifications: [] };
    const messages = await client.query<{
      channel: NotificationChannel;
      status: NotificationStatus;
      updated_at: Date;
    }>("SELECT channel, status, updated_at FROM notifications WHERE call_id = $1", [call.id]);
    return {
      call: { endedAt: call.ended_at, urgency: call.urgency, processed: call.processed },
      notifications: messages.rows.map((message) => ({
        channel: message.channel,
        status: message.status,
        statusAt: message.updated_at,
      })),
    };
  });
}
