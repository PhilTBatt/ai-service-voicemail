// Sends one billing email (BUILD_PLAN Step 12): a month's receipt, a payment that couldn't be
// collected, or a Direct Debit that ended. Once each, recorded in billing_emails by what it's
// about; through the outbound allowlist like every other message (CLAUDE.md rule 4).
import type { PgBoss } from "pg-boss";
import type pg from "pg";
import { raiseAlert, type AlertFn } from "../alerts.ts";
import {
  billingSituation,
  directDebitEndedEmail,
  paymentFailedEmail,
  receiptEmail,
  type EmailContent,
} from "../core/billing-emails.ts";
import { checkOutbound, type OutboundPolicy } from "../core/outbound-allowlist.ts";
import { withTenant } from "../db/tenant.ts";
import { logger } from "../logger.ts";
import type { EmailProvider } from "../providers/email.ts";
import { failureReasonOf, isRefusal } from "./deliver-notification.ts";
import { BILLING_EMAIL_QUEUE } from "./queue.ts";

export type BillingEmailKind = "receipt" | "payment_failed" | "direct_debit_ended";

export interface BillingEmailJobData {
  tenantId: string;
  kind: BillingEmailKind;
  /**
   * What the email is about, once each: the charge's ID for a receipt; the mandate's reference
   * for an ending; for a failed payment, the charge's ID and the provider's event that said so
   * ("<charge ID>:<event ID>"), so a month that fails again after Collect again is told again,
   * and one event delivered twice is told once. (The charge's ID alone when the morning run
   * finds the payment already failed: no event says so then.)
   */
  ref: string;
  /** The charge it's about, for a receipt or a failed payment. Without it, the ref is the charge's ID. */
  chargeId?: string | undefined;
}

/** Queues a billing email. Given a client, the job commits or rolls back with that transaction. */
export type EnqueueBillingEmail = (
  job: BillingEmailJobData,
  client?: pg.ClientBase,
) => Promise<unknown>;

export function enqueueBillingEmailWith(boss: PgBoss): EnqueueBillingEmail {
  return (job, client) =>
    boss.send(BILLING_EMAIL_QUEUE, job, {
      singletonKey: `${job.kind}:${job.ref}`,
      ...(client && {
        db: { executeSql: (text: string, values?: unknown[]) => client.query(text, values) },
      }),
    });
}

export interface BillingEmailDeps {
  pool: pg.Pool;
  email: EmailProvider;
  outbound: OutboundPolicy;
  /** Where the dashboard is, for the link to set a Direct Debit up again. */
  dashboardOrigin: string;
  alert?: AlertFn;
}

export type BillingEmailOutcome =
  "sent" | "blocked" | "no-email" | "refused" | "already-sent" | "not-found";

interface ChargeRow {
  period_start: string;
  period_end: string;
  lines: { description: string; pence: number }[];
  vat_rate_percent: number;
  vat_pence: number;
  total_pence: number;
  vat_number: string | null;
  charge_date: string | null;
}

export async function runBillingEmail(
  { pool, email, outbound, dashboardOrigin, alert = raiseAlert }: BillingEmailDeps,
  { tenantId, kind, ref, chargeId = ref }: BillingEmailJobData,
): Promise<BillingEmailOutcome> {
  const loaded = await withTenant(pool, tenantId, async (client) => {
    const done = await client.query("SELECT 1 FROM billing_emails WHERE kind = $1 AND ref = $2", [
      kind,
      ref,
    ]);
    if (done.rowCount !== 0) return "already-sent" as const;
    const tenant = (
      await client.query<{
        business_name: string;
        notification_email: string | null;
        status: string;
      }>("SELECT business_name, notification_email, status FROM tenants WHERE id = $1", [tenantId])
    ).rows[0];
    if (!tenant) return null;
    let charge: ChargeRow | undefined;
    if (kind !== "direct_debit_ended") {
      charge = (
        await client.query<ChargeRow>(
          `SELECT period_start::text, period_end::text, lines, vat_rate_percent, vat_pence,
                  total_pence, vat_number, charge_date::text
           FROM billing_charges WHERE id = $1`,
          [chargeId],
        )
      ).rows[0];
      if (!charge) return null;
    }
    return { tenant, charge };
  });
  if (loaded === "already-sent") return "already-sent";
  if (loaded === null) return "not-found";
  const { tenant, charge } = loaded;

  const record = (
    status: "sent" | "blocked" | "no_email" | "refused",
    providerRef: string | null = null,
  ) =>
    withTenant(pool, tenantId, (client) =>
      client.query(
        `INSERT INTO billing_emails (tenant_id, kind, ref, status, provider_ref)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (kind, ref) DO NOTHING`,
        [tenantId, kind, ref, status, providerRef],
      ),
    );

  const to = tenant.notification_email;
  if (!to) {
    await record("no_email");
    logger.warn("Billing email not sent: the business has no email address", { tenantId, kind });
    return "no-email";
  }
  const decision = checkOutbound(outbound, to);
  if (!decision.allowed) {
    await record("blocked");
    logger.warn("Billing email blocked by the outbound allowlist", {
      tenantId,
      kind,
      reason: decision.reason,
    });
    return "blocked";
  }

  const content: EmailContent =
    kind === "receipt"
      ? receiptEmail(tenant.business_name, {
          periodStart: charge!.period_start,
          periodEnd: charge!.period_end,
          lines: charge!.lines,
          vatRatePercent: charge!.vat_rate_percent,
          vatPence: charge!.vat_pence,
          totalPence: charge!.total_pence,
          vatNumber: charge!.vat_number,
          chargeDate: charge!.charge_date,
        })
      : kind === "payment_failed"
        ? paymentFailedEmail(
            tenant.business_name,
            {
              periodStart: charge!.period_start,
              periodEnd: charge!.period_end,
              totalPence: charge!.total_pence,
            },
            billingSituation(tenant.status),
          )
        : directDebitEndedEmail(
            tenant.business_name,
            `${dashboardOrigin}/tenants/${tenantId}/settings#billing`,
            billingSituation(tenant.status),
          );
  let receipt;
  try {
    receipt = await email.send({ to, ...content });
  } catch (error) {
    // Refused for good (an inactive address, an account that may not send there): recorded
    // and said once, not retried, as with the call emails.
    if (!isRefusal(error)) throw error;
    await record("refused");
    alert("notification-refused", {
      tenantId,
      channel: `billing:${kind}`,
      reason: failureReasonOf(error),
    });
    return "refused";
  }
  await record("sent", receipt.providerRef);
  logger.info("Billing email sent", { tenantId, kind });
  return "sent";
}
