// The offboarding job (BUILD_PLAN Step 13). Two actions:
// - "cancellation-notices": once a business cancels, text and email the tradesperson how to
//   turn their diverts off and get their voicemail back. Each channel goes out once.
// - "delete-data": once its number is released, delete the business's data at the providers
//   and here, with a written confirmation by email, or by text where email can't go.
// Every message goes through the outbound allowlist (CLAUDE.md rule 4).
import { voicemailRestoreCode, type MobileNetwork } from "@callmate/shared";
import type { PgBoss } from "pg-boss";
import type pg from "pg";
import { raiseAlert, type AlertFn } from "../alerts.ts";
import {
  cancellationEmail,
  cancellationText,
  deletionConfirmationEmail,
  deletionConfirmationText,
} from "../core/offboarding.ts";
import { checkOutbound, type OutboundPolicy } from "../core/outbound-allowlist.ts";
import { toGsm7 } from "../core/sms.ts";
import {
  deleteTenantData,
  deletionPlan,
  recordDeletionConfirmed,
  type AdminPool,
  type DeletionPlan,
} from "../db/cross-tenant.ts";
import { withTenant } from "../db/tenant.ts";
import { logger } from "../logger.ts";
import type { AuthProvider } from "../providers/auth.ts";
import type { EmailProvider } from "../providers/email.ts";
import type { SmsProvider } from "../providers/sms.ts";
import type { TelephonyProvider } from "../providers/telephony.ts";
import type { VoiceProvider } from "../providers/voice.ts";
import { OFFBOARDING_QUEUE } from "./queue.ts";

export type OffboardingAction = "cancellation-notices" | "delete-data";

export interface OffboardingJobData {
  tenantId: string;
  action: OffboardingAction;
  /** Who asked for a deletion, for the audit log. */
  actorUserId?: string;
}

/** Queues an offboarding action. Given a client, the job commits or rolls back with that transaction. */
export type EnqueueOffboarding = (
  job: OffboardingJobData,
  client?: pg.ClientBase,
) => Promise<unknown>;

export function enqueueOffboardingWith(boss: PgBoss): EnqueueOffboarding {
  return (job, client) =>
    boss.send(OFFBOARDING_QUEUE, job, {
      singletonKey: `${job.tenantId}:${job.action}`,
      ...(client && {
        db: { executeSql: (text: string, values?: unknown[]) => client.query(text, values) },
      }),
    });
}

export interface OffboardingJobDeps {
  pool: pg.Pool;
  sms: SmsProvider;
  /** Absent where email isn't configured (development): the text still goes. */
  email?: EmailProvider | undefined;
  outbound: OutboundPolicy;
  /** What deleting a business's data needs. Absent until the admin pool and Twilio are set up. */
  deletion?: DeletionDeps | undefined;
  /** Raises an alert for a person to act on (alerts.ts); tests pass a stand-in. */
  alert?: AlertFn;
  now?: () => Date;
}

export interface DeletionDeps {
  admin: AdminPool;
  voice: VoiceProvider;
  telephony: TelephonyProvider;
  /** For deleting logins. Absent where the login provider isn't configured. */
  auth?: AuthProvider | undefined;
}

type ChannelOutcome =
  "sent" | "blocked" | "already-sent" | "no-address" | "not-configured" | "failed";

export interface CancellationNoticesOutcome {
  sms: ChannelOutcome;
  email: ChannelOutcome;
}

export interface DeletionOutcome {
  outcome: "deleted" | "already-deleted" | "not-cancelled";
  /** How the written confirmation went, or "not-sent" (an alert was raised). */
  confirmation?: "email" | "sms" | "not-sent" | "already-sent";
  calls?: number;
}

export function runOffboardingJob(
  deps: OffboardingJobDeps,
  job: OffboardingJobData,
): Promise<CancellationNoticesOutcome | DeletionOutcome> {
  return job.action === "delete-data"
    ? deleteData(deps, job)
    : sendCancellationNotices(deps, job.tenantId);
}

interface TenantForNotices {
  business_name: string;
  notification_mobile: string | null;
  notification_email: string | null;
  mobile_network: MobileNetwork | null;
  voicemail_restore_code: string | null;
  sms_sent: boolean;
  email_sent: boolean;
}

async function sendCancellationNotices(
  deps: OffboardingJobDeps,
  tenantId: string,
): Promise<CancellationNoticesOutcome> {
  const tenant = await withTenant(deps.pool, tenantId, async (client) => {
    const row = (
      await client.query<TenantForNotices>(
        `SELECT business_name, notification_mobile, notification_email, mobile_network,
                voicemail_restore_code,
                EXISTS (SELECT 1 FROM offboarding_messages m WHERE m.tenant_id = tenants.id
                        AND m.kind = 'cancellation' AND m.channel = 'sms' AND m.status = 'sent') AS sms_sent,
                EXISTS (SELECT 1 FROM offboarding_messages m WHERE m.tenant_id = tenants.id
                        AND m.kind = 'cancellation' AND m.channel = 'email' AND m.status = 'sent') AS email_sent
         FROM tenants WHERE id = $1`,
        [tenantId],
      )
    ).rows[0];
    if (!row) throw new Error(`Tenant ${tenantId} not found`);
    return row;
  });

  const notice = {
    businessName: tenant.business_name,
    network: tenant.mobile_network,
    restoreCode: tenant.voicemail_restore_code ?? voicemailRestoreCode(tenant.mobile_network),
  };
  const record = (
    channel: "sms" | "email",
    status: "sent" | "blocked",
    providerRef: string | null,
  ) =>
    withTenant(deps.pool, tenantId, (client) =>
      client.query(
        "INSERT INTO offboarding_messages (tenant_id, kind, channel, status, provider_ref) VALUES ($1, 'cancellation', $2, $3, $4)",
        [tenantId, channel, status, providerRef],
      ),
    );

  const sms = async (): Promise<ChannelOutcome> => {
    if (tenant.sms_sent) return "already-sent";
    const to = tenant.notification_mobile;
    if (!to) return "no-address";
    if (!checkOutbound(deps.outbound, to).allowed) {
      await record("sms", "blocked", null);
      return "blocked";
    }
    const receipt = await deps.sms.send({ to, body: toGsm7(cancellationText(notice)) });
    await record("sms", "sent", receipt.providerRef);
    return "sent";
  };

  const email = async (): Promise<ChannelOutcome> => {
    if (tenant.email_sent) return "already-sent";
    const to = tenant.notification_email;
    if (!to) return "no-address";
    if (!deps.email) return "not-configured";
    if (!checkOutbound(deps.outbound, to).allowed) {
      await record("email", "blocked", null);
      return "blocked";
    }
    const receipt = await deps.email.send({ to, ...cancellationEmail(notice) });
    await record("email", "sent", receipt.providerRef);
    return "sent";
  };

  // Each channel on its own, so one that fails (a refused number, a bounced address) doesn't
  // stop the other. A failure is then thrown so the queue retries it: the retry finds the other
  // channel already sent and skips it, and after the last retry the dead-letter alert fires.
  const settle = async (
    send: () => Promise<ChannelOutcome>,
  ): Promise<{ outcome: ChannelOutcome; failure?: string }> => {
    try {
      return { outcome: await send() };
    } catch (error) {
      return { outcome: "failed", failure: failureName(error) };
    }
  };
  const results = { sms: await settle(sms), email: await settle(email) };
  const outcome = { sms: results.sms.outcome, email: results.email.outcome };
  logger.info("Cancellation notices handled", { tenantId, ...outcome });
  const failed = (["sms", "email"] as const).filter(
    (channel) => results[channel].failure !== undefined,
  );
  if (failed.length > 0) {
    const what = failed.map((channel) => `${channel} failed (${results[channel].failure})`);
    throw new Error(`Cancellation ${what.join(", ")}`);
  }
  return outcome;
}

/** What went wrong, without the provider's message, which can quote the address. */
function failureName(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? `${error.name} ${status}` : error.name;
}

/** A Twilio recording's SID, from the resource URL stored as the call's recording reference. */
const recordingSid = (recordingRef: string) => /RE[0-9a-f]{32}/.exec(recordingRef)?.[0] ?? null;

/**
/**
 * Deletes a business's data (BUILD_PLAN Step 13): first at the providers, every step of which is
 * safe to repeat, so a failure part-way just runs again on retry; then the written confirmation,
 * once; then everything here in one transaction (db/cross-tenant.ts deleteTenantData). A lock
 * keeps two runs for one business apart: a run that outlasts the job's expiry could otherwise
 * meet its own retry, and confirm twice.
 */
async function deleteData(
  deps: OffboardingJobDeps,
  job: OffboardingJobData,
): Promise<DeletionOutcome> {
  const deletion = deps.deletion;
  if (!deletion) throw new Error("Deleting data needs the admin pool and Twilio configured");
  const lock = await deletion.admin.connect();
  const key = `delete-data:${job.tenantId}`;
  try {
    const { rows } = await lock.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [key],
    );
    if (!rows[0]?.locked) throw new Error(`Deleting ${job.tenantId}'s data is already running`);
    try {
      return await deleteDataLocked(deps, deletion, job);
    } finally {
      await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [key]);
    }
  } finally {
    lock.release();
  }
}

async function deleteDataLocked(
  deps: OffboardingJobDeps,
  { admin, voice, telephony, auth }: DeletionDeps,
  job: OffboardingJobData,
): Promise<DeletionOutcome> {
  const plan = await deletionPlan(admin, job.tenantId);
  if (!plan) throw new Error(`Tenant ${job.tenantId} not found`);
  if (plan.dataDeletedAt) return { outcome: "already-deleted" };
  if (plan.status !== "cancelled") {
    logger.warn("Deletion refused: the business hasn't finished cancelling", {
      tenantId: job.tenantId,
    });
    return { outcome: "not-cancelled" };
  }
  // Checked before anything goes, so a missing setting can't leave a deletion half done.
  if (plan.logins.length > 0 && !auth) {
    throw new Error("Deleting a login needs CLERK_SECRET_KEY set for the worker");
  }

  // 1. At the providers.
  for (const call of plan.calls) {
    if (call.viaFallback) {
      const sid = call.recordingRef ? recordingSid(call.recordingRef) : null;
      if (sid) await telephony.deleteRecording(sid);
    } else {
      await voice.deleteCallData(call.providerCallId);
    }
  }
  for (const agentId of plan.agentIds) await voice.deleteAgent(agentId);
  for (const { number, since, until } of plan.numbers) {
    for (const sid of await telephony.listCallSids({ to: number, since, until })) {
      await telephony.deleteCall(sid);
    }
  }
  for (const ref of plan.messageRefs) await deps.sms.deleteMessage(ref);
  for (const subject of plan.logins) await auth?.deleteLogin(subject);

  // 2. The written confirmation, before the addresses go, and only once. If neither email nor
  //    text can carry it, an alert asks Phil to confirm another way; the deletion still happens.
  let confirmation: DeletionOutcome["confirmation"] = "already-sent";
  if (!plan.confirmationSent) {
    const sent = await sendDeletionConfirmation(deps, job.tenantId, plan);
    await recordDeletionConfirmed(admin, job.tenantId, sent);
    confirmation = sent.sentBy ?? "not-sent";
    if (!sent.sentBy) {
      // The name is how Phil will know which business: the row is about to be anonymised.
      (deps.alert ?? raiseAlert)("deletion-confirmation-not-sent", {
        tenantId: job.tenantId,
        businessName: plan.businessName,
        email: sent.email,
        sms: sent.sms,
      });
    }
  }

  // 3. Here.
  const { calls } = await deleteTenantData(admin, job.tenantId, {
    now: (deps.now ?? (() => new Date()))(),
    actorUserId: job.actorUserId ?? null,
  });
  logger.info("Business data deleted", { tenantId: job.tenantId, calls, confirmation });
  return { outcome: "deleted", confirmation, calls };
}

/** Why a channel didn't carry the confirmation. */
type NotSent = "no-address" | "not-configured" | "blocked" | "failed";

/**
 * The written confirmation by email, or by text where the email can't go: no address, one
 * Postmark refuses after a bounce, or the allowlist. Never throws: what happened is the answer.
 */
async function sendDeletionConfirmation(
  deps: OffboardingJobDeps,
  tenantId: string,
  plan: DeletionPlan,
): Promise<
  { sentBy: "email" | "sms"; providerRef: string } | { sentBy: null; email: NotSent; sms: NotSent }
> {
  let email: NotSent;
  const emailTo = plan.notificationEmail;
  if (!emailTo) email = "no-address";
  else if (!deps.email) email = "not-configured";
  else if (!checkOutbound(deps.outbound, emailTo).allowed) email = "blocked";
  else {
    try {
      const receipt = await deps.email.send({
        to: emailTo,
        ...deletionConfirmationEmail(plan.businessName),
      });
      return { sentBy: "email", providerRef: receipt.providerRef };
    } catch (error) {
      logger.warn("Deletion confirmation email failed; trying a text", {
        tenantId,
        failure: failureName(error),
      });
      email = "failed";
    }
  }

  let sms: NotSent;
  const smsTo = plan.notificationMobile;
  if (!smsTo) sms = "no-address";
  else if (!checkOutbound(deps.outbound, smsTo).allowed) sms = "blocked";
  else {
    try {
      const receipt = await deps.sms.send({
        to: smsTo,
        body: toGsm7(deletionConfirmationText(plan.businessName)),
      });
      return { sentBy: "sms", providerRef: receipt.providerRef };
    } catch (error) {
      logger.warn("Deletion confirmation text failed", { tenantId, failure: failureName(error) });
      sms = "failed";
    }
  }
  return { sentBy: null, email, sms };
}
