// The offboarding job (BUILD_PLAN Step 13). "cancellation-notices": once a business cancels,
// text and email the tradesperson how to turn their diverts off and get their voicemail back.
// Each channel goes out once and through the outbound allowlist (CLAUDE.md rule 4).
import { voicemailRestoreCode, type MobileNetwork } from "@callmate/shared";
import type { PgBoss } from "pg-boss";
import type pg from "pg";
import { cancellationEmail, cancellationText } from "../core/offboarding.ts";
import { checkOutbound, type OutboundPolicy } from "../core/outbound-allowlist.ts";
import { toGsm7 } from "../core/sms.ts";
import { withTenant } from "../db/tenant.ts";
import { logger } from "../logger.ts";
import type { EmailProvider } from "../providers/email.ts";
import type { SmsProvider } from "../providers/sms.ts";
import { OFFBOARDING_QUEUE } from "./queue.ts";

export type OffboardingAction = "cancellation-notices";

export interface OffboardingJobData {
  tenantId: string;
  action: OffboardingAction;
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
}

type ChannelOutcome = "sent" | "blocked" | "already-sent" | "no-address" | "not-configured";

export interface CancellationNoticesOutcome {
  sms: ChannelOutcome;
  email: ChannelOutcome;
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

export async function runOffboardingJob(
  deps: OffboardingJobDeps,
  { tenantId }: OffboardingJobData,
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

  // One after the other: if the email fails, a retry finds the text already sent and skips it.
  const outcome = { sms: await sms(), email: await email() };
  logger.info("Cancellation notices handled", { tenantId, ...outcome });
  return outcome;
}
