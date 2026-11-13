// The onboarding job (BUILD_PLAN Step 11). Two actions:
// - "send-divert-instructions": texts the tradesperson how to send missed calls to their
//   AnswerMate number, for their network, and moves onboarding on from "assistant set up".
// - "go-live": after the test call, takes the business live if the go-live rule allows, and
//   texts the tradesperson that it's live (once, ever).
// Texts go through the outbound allowlist like every other message (CLAUDE.md rule 4).
import { divertInstructions, divertInstructionsText, type MobileNetwork } from "@callmate/shared";
import type { PgBoss } from "pg-boss";
import type pg from "pg";
import { raiseAlert, type AlertFn } from "../alerts.ts";
import { checkOutbound, type OutboundPolicy } from "../core/outbound-allowlist.ts";
import { smsEncoding, toGsm7 } from "../core/sms.ts";
import { applyEarlyReceipt, raiseReceiptAlert } from "../db/delivery-receipts.ts";
import { advanceOnboarding } from "../db/onboarding.ts";
import { withTenant } from "../db/tenant.ts";
import { logger } from "../logger.ts";
import type { SmsProvider } from "../providers/sms.ts";
import { ONBOARDING_QUEUE } from "./queue.ts";

export type OnboardingAction = "send-divert-instructions" | "go-live";

export interface OnboardingJobData {
  tenantId: string;
  action: OnboardingAction;
}

/** Queues an onboarding action. Given a client, the job commits or rolls back with that transaction. */
export type EnqueueOnboarding = (
  job: OnboardingJobData,
  client?: pg.ClientBase,
) => Promise<unknown>;

export function enqueueOnboardingWith(boss: PgBoss): EnqueueOnboarding {
  return (job, client) =>
    boss.send(ONBOARDING_QUEUE, job, {
      // One of each action per business queued or running at a time.
      singletonKey: `${job.tenantId}:${job.action}`,
      ...(client && {
        db: { executeSql: (text: string, values?: unknown[]) => client.query(text, values) },
      }),
    });
}

export interface OnboardingJobDeps {
  pool: pg.Pool;
  sms: SmsProvider;
  outbound: OutboundPolicy;
  /** Where the dashboard is, for the link to the full divert steps. */
  dashboardOrigin: string;
  /** Takes the step to live. Tests stand in for an admin doing it at the same moment. */
  advance?: typeof advanceOnboarding;
  /** For a text Twilio said wasn't delivered before its ID was saved; tests pass a stand-in. */
  alert?: AlertFn;
}

export type OnboardingOutcome =
  "sent" | "blocked" | "already-sent" | "missing-number-or-mobile" | "not-ready" | "not-live";

export function runOnboardingJob(
  deps: OnboardingJobDeps,
  { tenantId, action }: OnboardingJobData,
): Promise<OnboardingOutcome> {
  return action === "send-divert-instructions"
    ? sendDivertInstructions(deps, tenantId)
    : goLive(deps, tenantId);
}

async function sendText(
  { pool, sms, outbound, alert = raiseAlert }: OnboardingJobDeps,
  tenantId: string,
  kind: "divert_instructions" | "go_live",
  to: string,
  body: string,
): Promise<"sent" | "blocked"> {
  const decision = checkOutbound(outbound, to);
  const text = toGsm7(body);
  const receipt = decision.allowed ? await sms.send({ to, body: text }) : null;
  // What the cost estimate counts it at: the provider's count, or ours when it gives none.
  // A text is at least one segment (the column refuses 0, which would fail after the send).
  const segments = receipt ? Math.max(1, receipt.segments ?? smsEncoding(text).segments) : null;
  const early = await withTenant(pool, tenantId, async (client) => {
    await client.query(
      "INSERT INTO onboarding_texts (tenant_id, kind, status, provider_ref, segments) VALUES ($1, $2, $3, $4, $5)",
      [tenantId, kind, receipt ? "sent" : "blocked", receipt?.providerRef ?? null, segments],
    );
    // Twilio may already have said what became of it, before this saved its ID: that receipt
    // was kept, and is applied now (db/delivery-receipts.ts).
    return receipt ? applyEarlyReceipt(client, "sms", receipt.providerRef) : null;
  });
  raiseReceiptAlert(alert, tenantId, early);
  if (!decision.allowed) {
    logger.warn("Onboarding text blocked by the outbound allowlist", {
      tenantId,
      kind,
      reason: decision.reason,
    });
    return "blocked";
  }
  logger.info("Onboarding text sent", { tenantId, kind });
  return "sent";
}

interface TenantForTexts {
  business_name: string;
  onboarding_state: string;
  notification_mobile: string | null;
  mobile_network: MobileNetwork | null;
  number: string | null;
  go_live_sent: boolean;
}

function loadTenant(pool: pg.Pool, tenantId: string): Promise<TenantForTexts> {
  return withTenant(pool, tenantId, async (client) => {
    const row = (
      await client.query<TenantForTexts>(
        `SELECT business_name, onboarding_state, notification_mobile, mobile_network,
                (SELECT number FROM phone_numbers
                 WHERE tenant_id = tenants.id AND status = 'active') AS number,
                EXISTS (SELECT 1 FROM onboarding_texts
                        WHERE tenant_id = tenants.id AND kind = 'go_live' AND status = 'sent') AS go_live_sent
         FROM tenants WHERE id = $1`,
        [tenantId],
      )
    ).rows[0];
    if (!row) throw new Error(`Tenant ${tenantId} not found`);
    return row;
  });
}

async function sendDivertInstructions(
  deps: OnboardingJobDeps,
  tenantId: string,
): Promise<OnboardingOutcome> {
  const tenant = await loadTenant(deps.pool, tenantId);
  if (!tenant.number || !tenant.notification_mobile) {
    logger.warn("Divert instructions not sent: no number or no mobile", { tenantId });
    return "missing-number-or-mobile";
  }
  const steps = `${deps.dashboardOrigin}/tenants/${tenantId}/phone`;
  const body = divertInstructionsText(tenant.mobile_network, tenant.number, steps);
  const outcome = await sendText(
    deps,
    tenantId,
    "divert_instructions",
    tenant.notification_mobile,
    body,
  );
  if (outcome !== "sent") return outcome;

  const { restoreVoicemail } = divertInstructions(tenant.mobile_network, tenant.number);
  await withTenant(deps.pool, tenantId, async (client) => {
    await client.query("UPDATE tenants SET voicemail_restore_code = $2 WHERE id = $1", [
      tenantId,
      restoreVoicemail,
    ]);
    // Sent: that's the step done, if this is where the business is. A resend later moves nothing.
    const moved = await client.query(
      "UPDATE tenants SET onboarding_state = 'divert_instructions_sent' WHERE id = $1 AND onboarding_state = 'agent_synced'",
      [tenantId],
    );
    if (moved.rowCount === 1) {
      await client.query(
        "INSERT INTO audit_log (tenant_id, actor_user_id, action, details) VALUES ($1, NULL, 'onboarding.advanced', $2)",
        [
          tenantId,
          { via: "divert instructions text", from: "agent_synced", to: "divert_instructions_sent" },
        ],
      );
    }
  });
  return "sent";
}

async function goLive(deps: OnboardingJobDeps, tenantId: string): Promise<OnboardingOutcome> {
  let tenant = await loadTenant(deps.pool, tenantId);
  if (tenant.onboarding_state === "test_call_received") {
    const result = await (deps.advance ?? advanceOnboarding)(deps.pool, tenantId, "live", null);
    // Read it again either way: an admin may have taken it live by hand a moment ago, which
    // refuses this step, and the go-live text must still go (the admin's own job was dropped
    // as a duplicate of this one).
    tenant = await loadTenant(deps.pool, tenantId);
    if (tenant.onboarding_state !== "live") {
      // Not an error: an admin sees the reason on the Onboarding tab and sorts it.
      logger.info("Test call received, not live yet", {
        tenantId,
        reason: result.outcome === "refused" ? result.reason : result.outcome,
      });
      return "not-ready";
    }
  }
  if (tenant.onboarding_state !== "live") return "not-live";
  if (tenant.go_live_sent) return "already-sent";
  if (!tenant.notification_mobile) return "missing-number-or-mobile";
  return sendText(
    deps,
    tenantId,
    "go_live",
    tenant.notification_mobile,
    `AnswerMate is live for ${tenant.business_name}. Calls you don't answer now go to your assistant, and you'll get a text about each one.`,
  );
}
