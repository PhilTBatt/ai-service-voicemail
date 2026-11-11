// "Called back" (an addition to the plan, 2026-11-11): a call marked dealt with, or open again.
// From the dashboard (who did it is known) or from the page a text links to (no login, so only
// that it came from the link). Inside the call's tenant, like every tenant write.
import type pg from "pg";
import { withTenant } from "./tenant.ts";

/**
 * What still needs a reply: not marked as called back, and not spam. The call list's filter
 * and the STATUS text's count share it, so they always agree.
 */
export const NEEDS_REPLY_SQL = "handled_at IS NULL AND urgency IS DISTINCT FROM 'spam'";

/**
 * Marks a call called back (keeping the first time it was, if it already was) or open again,
 * and records the change in the audit log; a change that changes nothing adds no audit row.
 * Null when the business has no such call.
 */
export async function setCallHandled(
  pool: pg.Pool,
  {
    tenantId,
    callId,
    handled,
    actorUserId,
    via,
  }: {
    tenantId: string;
    callId: string;
    handled: boolean;
    actorUserId: string | null;
    via: "dashboard" | "link";
  },
): Promise<{ handledAt: Date | null } | null> {
  return withTenant(pool, tenantId, async (client) => {
    const before = (
      await client.query<{ handled_at: Date | null }>(
        "SELECT handled_at FROM calls WHERE id = $1 FOR UPDATE",
        [callId],
      )
    ).rows[0];
    if (!before) return null;
    if (handled === (before.handled_at !== null)) return { handledAt: before.handled_at };
    const after = (
      await client.query<{ handled_at: Date | null }>(
        `UPDATE calls
         SET handled_at = CASE WHEN $2 THEN now() END,
             handled_by = CASE WHEN $2 THEN $3::uuid END
         WHERE id = $1
         RETURNING handled_at`,
        [callId, handled, actorUserId],
      )
    ).rows[0]!;
    await client.query(
      "INSERT INTO audit_log (tenant_id, actor_user_id, action, details) VALUES ($1, $2, $3, $4)",
      [tenantId, actorUserId, handled ? "call.called-back" : "call.reopened", { callId, via }],
    );
    return { handledAt: after.handled_at };
  });
}
