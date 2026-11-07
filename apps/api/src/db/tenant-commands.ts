// Applies an SMS command to a tenant (BUILD_PLAN Step 6) and composes the reply. Everything
// runs inside the tenant's transaction; status changes are written to audit_log.
import type pg from "pg";
import type { TenantStatus } from "@callmate/shared";
import { UK_TIME_ZONE } from "../core/availability.ts";
import {
  HELP_REPLY,
  HOLIDAY_INVALID_REPLY,
  UNKNOWN_REPLY,
  formatUkDate,
  type SmsCommand,
} from "../core/sms-commands.ts";
import { withTenant } from "./tenant.ts";

export interface CommandResult {
  reply: string;
  /** The profile version to re-sync when holiday mode changed (its prompt names the date). */
  resyncProfileVersion?: number;
}

interface TenantState {
  status: TenantStatus;
  holidayMode: boolean;
  holidayUntil: string | null;
  latestVersion: number | null;
}

async function loadState(client: pg.ClientBase, tenantId: string): Promise<TenantState> {
  const tenant = (
    await client.query<{ status: TenantStatus }>("SELECT status FROM tenants WHERE id = $1", [
      tenantId,
    ])
  ).rows[0];
  if (!tenant) throw new Error(`Tenant ${tenantId} not found`);
  const profile = (
    await client.query<{ version: number; holiday_mode: boolean; holiday_until: string | null }>(
      `SELECT version, holiday_mode, to_char(holiday_until, 'YYYY-MM-DD') AS holiday_until
       FROM agent_profiles WHERE tenant_id = $1 ORDER BY version DESC LIMIT 1`,
      [tenantId],
    )
  ).rows[0];
  return {
    status: tenant.status,
    holidayMode: profile?.holiday_mode ?? false,
    holidayUntil: profile?.holiday_until ?? null,
    latestVersion: profile?.version ?? null,
  };
}

function audit(client: pg.ClientBase, tenantId: string, action: string, details: object) {
  return client.query(
    `INSERT INTO audit_log (tenant_id, actor_user_id, action, details) VALUES ($1, NULL, $2, $3)`,
    [tenantId, action, JSON.stringify({ via: "sms", ...details })],
  );
}

/**
 * Holiday mode is operational state, not agent configuration, so it's changed on every
 * profile version in place: the per-call variables read the latest synced version, and a
 * new unsynced version wouldn't take effect until the sync finished.
 */
async function setHoliday(
  client: pg.ClientBase,
  tenantId: string,
  holidayMode: boolean,
  holidayUntil: string | null,
) {
  await client.query(
    "UPDATE agent_profiles SET holiday_mode = $2, holiday_until = $3 WHERE tenant_id = $1",
    [tenantId, holidayMode, holidayUntil],
  );
}

function holidayLine(state: TenantState): string {
  if (!state.holidayMode) return "Holiday mode is off.";
  return state.holidayUntil
    ? `Holiday mode is on until ${formatUkDate(state.holidayUntil)}.`
    : "Holiday mode is on until you reply ON.";
}

export async function applySmsCommand(
  pool: pg.Pool,
  tenantId: string,
  command: SmsCommand,
  now: Date,
): Promise<CommandResult> {
  return withTenant(pool, tenantId, async (client) => {
    const state = await loadState(client, tenantId);
    switch (command.kind) {
      case "off":
        if (state.status === "paused")
          return { reply: "AnswerMate is already OFF. Reply ON to switch it back on." };
        if (state.status !== "live") return { reply: cannotChange(state.status) };
        await client.query("UPDATE tenants SET status = 'paused' WHERE id = $1", [tenantId]);
        await audit(client, tenantId, "tenant.paused", {});
        return {
          reply:
            "AnswerMate is now OFF. Callers can leave a voicemail. Reply ON to switch it back on.",
        };

      case "on": {
        if (state.status !== "live" && state.status !== "paused") {
          return { reply: cannotChange(state.status) };
        }
        const resumed = state.status === "paused";
        if (resumed) {
          await client.query("UPDATE tenants SET status = 'live' WHERE id = $1", [tenantId]);
          await audit(client, tenantId, "tenant.resumed", {});
        }
        const endedHoliday = state.holidayMode;
        if (endedHoliday) {
          await setHoliday(client, tenantId, false, null);
          await audit(client, tenantId, "holiday.ended", {});
        }
        if (!resumed && !endedHoliday) return { reply: "AnswerMate is already ON." };
        return {
          reply: `AnswerMate is ON and answering calls.${endedHoliday ? " Holiday mode is off." : ""}`,
          ...(endedHoliday &&
            state.latestVersion !== null && { resyncProfileVersion: state.latestVersion }),
        };
      }

      case "holiday": {
        if (state.latestVersion === null) {
          return { reply: "Holiday mode needs your assistant to be set up first." };
        }
        await setHoliday(client, tenantId, true, command.until);
        await audit(client, tenantId, "holiday.set", { until: command.until });
        return {
          reply: `Holiday mode is on until ${formatUkDate(command.until)}. Callers will be told you're away and you'll still get their messages. Reply ON to end it early.`,
          resyncProfileVersion: state.latestVersion,
        };
      }

      case "holiday-invalid":
        return { reply: HOLIDAY_INVALID_REPLY };

      case "status": {
        const startOfToday = Temporal.Instant.fromEpochMilliseconds(now.getTime())
          .toZonedDateTimeISO(UK_TIME_ZONE)
          .startOfDay();
        const callsToday = (
          await client.query<{ n: string }>(
            "SELECT count(*) AS n FROM calls WHERE tenant_id = $1 AND started_at >= $2",
            [tenantId, new Date(startOfToday.epochMilliseconds)],
          )
        ).rows[0]!.n;
        return {
          reply: `AnswerMate is ${statusWord(state.status)}. ${holidayLine(state)} Calls today: ${callsToday}.`,
        };
      }

      case "help":
        return { reply: HELP_REPLY };

      case "unknown":
        return { reply: UNKNOWN_REPLY };
    }
  });
}

function statusWord(status: TenantStatus): string {
  switch (status) {
    case "live":
    case "demo":
      return "ON";
    case "paused":
      return "OFF";
    default:
      return `not active (${status})`;
  }
}

function cannotChange(status: TenantStatus): string {
  return `AnswerMate can't be switched on or off by text while your account is ${status}. Please contact support.`;
}
