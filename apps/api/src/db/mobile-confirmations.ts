// Confirming a notification mobile by texted code (PROGRESS open question 4): the rows behind
// core/mobile-confirmation.ts. Everything runs in the business's transaction; the code is stored
// hashed; each step is audited without the number (the audit log stays free of contact details).
import type pg from "pg";
import {
  MOBILE_CODES_PER_HOUR,
  MOBILE_CODE_MAX_ATTEMPTS,
  MOBILE_CODE_TTL_MS,
  hashMobileCode,
  newMobileCode,
} from "../core/mobile-confirmation.ts";
import { withTenant } from "./tenant.ts";

const HOUR_MS = 60 * 60_000;

export type StartConfirmationResult =
  /** A code to text to the mobile; it's good until `expiresAt`. */
  | { outcome: "started"; code: string; expiresAt: Date }
  /** Three codes already in the last hour: the next can be asked for at `retryAt`. */
  | { outcome: "too-many-codes"; retryAt: Date };

/**
 * Starts confirming `mobile` for the business: an earlier open code stops working, a new one is
 * made and recorded (hashed), and the caller texts it. `makeCode` is for tests and the browser
 * tests' server, which need to know the code.
 */
export async function startMobileConfirmation(
  pool: pg.Pool,
  tenantId: string,
  mobile: string,
  actorUserId: string,
  now: Date,
  makeCode: () => string = newMobileCode,
): Promise<StartConfirmationResult> {
  return withTenant(pool, tenantId, async (client) => {
    const recent = (
      await client.query<{ n: number; oldest: Date | null }>(
        `SELECT count(*)::int AS n, min(created_at) AS oldest FROM mobile_confirmations
         WHERE tenant_id = $1 AND created_at > $2`,
        [tenantId, new Date(now.getTime() - HOUR_MS)],
      )
    ).rows[0]!;
    if (recent.n >= MOBILE_CODES_PER_HOUR && recent.oldest) {
      return { outcome: "too-many-codes", retryAt: new Date(recent.oldest.getTime() + HOUR_MS) };
    }
    // One live code at a time: the earlier ones expire now.
    await client.query(
      `UPDATE mobile_confirmations SET expires_at = $2
       WHERE tenant_id = $1 AND confirmed_at IS NULL AND expires_at > $2`,
      [tenantId, now],
    );
    const code = makeCode();
    const expiresAt = new Date(now.getTime() + MOBILE_CODE_TTL_MS);
    await client.query(
      `INSERT INTO mobile_confirmations (tenant_id, mobile, code_hash, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenantId, mobile, hashMobileCode(code, tenantId), expiresAt, now],
    );
    await client.query(
      "INSERT INTO audit_log (tenant_id, actor_user_id, action, details) VALUES ($1, $2, 'mobile.code-sent', $3)",
      [tenantId, actorUserId, { via: "dashboard" }],
    );
    return { outcome: "started", code, expiresAt };
  });
}

export type ConfirmMobileResult =
  | { outcome: "confirmed"; mobile: string }
  | { outcome: "wrong-code"; attemptsLeft: number }
  | { outcome: "expired" }
  | { outcome: "too-many-attempts" }
  | { outcome: "nothing-pending" };

/** Checks a typed code against the business's open one, and on a match makes the mobile theirs. */
export async function confirmMobile(
  pool: pg.Pool,
  tenantId: string,
  code: string,
  actorUserId: string,
  now: Date,
): Promise<ConfirmMobileResult> {
  return withTenant(pool, tenantId, async (client) => {
    const open = (
      await client.query<{
        id: string;
        mobile: string;
        code_hash: string;
        attempts: number;
        expires_at: Date;
      }>(
        // The live code if there is one (two made in the same instant must still find it), else
        // the latest, to say it expired.
        `SELECT id, mobile, code_hash, attempts, expires_at FROM mobile_confirmations
         WHERE tenant_id = $1 AND confirmed_at IS NULL
         ORDER BY expires_at > $2 DESC, created_at DESC, expires_at DESC LIMIT 1 FOR UPDATE`,
        [tenantId, now],
      )
    ).rows[0];
    if (!open) return { outcome: "nothing-pending" };
    if (open.expires_at.getTime() <= now.getTime()) return { outcome: "expired" };
    if (open.attempts >= MOBILE_CODE_MAX_ATTEMPTS) return { outcome: "too-many-attempts" };
    if (open.code_hash !== hashMobileCode(code, tenantId)) {
      await client.query("UPDATE mobile_confirmations SET attempts = attempts + 1 WHERE id = $1", [
        open.id,
      ]);
      return { outcome: "wrong-code", attemptsLeft: MOBILE_CODE_MAX_ATTEMPTS - open.attempts - 1 };
    }
    await client.query("UPDATE tenants SET notification_mobile = $2 WHERE id = $1", [
      tenantId,
      open.mobile,
    ]);
    await client.query("UPDATE mobile_confirmations SET confirmed_at = $2 WHERE id = $1", [
      open.id,
      now,
    ]);
    // The same entry the Account page's other changes write, so the account log reads as one.
    await client.query(
      "INSERT INTO audit_log (tenant_id, actor_user_id, action, details) VALUES ($1, $2, 'notifications.changed', $3)",
      [
        tenantId,
        actorUserId,
        { via: "dashboard", changed: ["notificationMobile"], confirmed: true },
      ],
    );
    return { outcome: "confirmed", mobile: open.mobile };
  });
}

/** The mobile waiting for its code, if there is one that can still be confirmed. */
export async function pendingMobile(
  client: pg.ClientBase,
  tenantId: string,
  now: Date,
): Promise<{ mobile: string; expiresAt: Date } | null> {
  const open = (
    await client.query<{ mobile: string; expires_at: Date }>(
      `SELECT mobile, expires_at FROM mobile_confirmations
       WHERE tenant_id = $1 AND confirmed_at IS NULL AND expires_at > $2 AND attempts < $3
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId, now, MOBILE_CODE_MAX_ATTEMPTS],
    )
  ).rows[0];
  return open ? { mobile: open.mobile, expiresAt: open.expires_at } : null;
}
