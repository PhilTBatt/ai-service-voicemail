// The payments provider's webhook (BUILD_PLAN Step 12; decision 019): POST /webhooks/gocardless.
// GoCardless signs the exact bytes it sends, so this route keeps the raw body for the check.
// Each request carries a batch of events; each is handled once, by its event ID
// (db/direct-debit.ts), so a delivery repeated, or retried after a failure part-way through a
// batch, is safe. GoCardless's docs: answer 2xx within 10 seconds; 498 for a bad signature,
// which it doesn't retry; anything else that isn't 2xx is retried, up to 8 times.
import { Router, raw } from "express";
import type pg from "pg";
import { raiseAlert, type AlertFn } from "../alerts.ts";
import { SIGNATURE_FAILURES_PER_WINDOW, Spike } from "../core/spike.ts";
import { handlePaymentsEvent } from "../db/direct-debit.ts";
import type { EnqueueBillingEmail } from "../jobs/billing-email.ts";
import type { EnqueueOnboarding } from "../jobs/onboarding.ts";
import { logger } from "../logger.ts";
import { PaymentsWebhookError, type PaymentsProvider } from "../providers/payments.ts";

export interface PaymentsWebhookOptions {
  pool: pg.Pool;
  provider: PaymentsProvider;
  enqueueOnboarding?: EnqueueOnboarding | undefined;
  /** Emails the business when a payment fails or its Direct Debit ends. */
  enqueueBillingEmail?: EnqueueBillingEmail | undefined;
  alert?: AlertFn;
  now?: () => Date;
}

/** GoCardless's documented answer to a bad signature: "498 Token Invalid", not retried. */
export const INVALID_SIGNATURE_STATUS = 498;

export function paymentsWebhookRouter({
  pool,
  provider,
  enqueueOnboarding,
  enqueueBillingEmail,
  alert = raiseAlert,
  now = () => new Date(),
}: PaymentsWebhookOptions) {
  const router = Router();
  const refusals = new Spike({ limit: SIGNATURE_FAILURES_PER_WINDOW });

  router.post("/", raw({ type: () => true, limit: "1mb" }), async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    let events;
    try {
      events = provider.verifyAndParseWebhook(rawBody, req.headers);
    } catch (error) {
      if (!(error instanceof PaymentsWebhookError)) throw error;
      logger.warn("Rejected payments webhook", { reason: error.message });
      if (refusals.record(now())) {
        alert("webhook-signature-spike", { source: "gocardless", inWindow: refusals.count });
      }
      res.status(INVALID_SIGNATURE_STATUS).json({ error: "Invalid signature" });
      return;
    }

    // One at a time, in the order sent. A failure answers 500, so the provider sends the
    // whole batch again; the events already handled are recognised and skipped.
    for (const event of events) {
      const result = await handlePaymentsEvent(pool, event, {
        enqueueOnboarding,
        enqueueBillingEmail,
      });
      logger.info("Payments event", {
        eventId: event.id,
        resourceType: event.resourceType,
        action: event.action,
        outcome: result.outcome,
        ...(result.outcome !== "unknown" && { tenantId: result.tenantId }),
      });
      if (result.outcome === "handled" && result.mandateEnded) {
        alert("payment-mandate-ended", {
          tenantId: result.tenantId,
          status: result.mandateEnded.status,
          reason: result.mandateEnded.reason,
        });
      }
      if (result.outcome === "handled" && result.paymentFailed) {
        alert("billing-payment-failed", {
          tenantId: result.tenantId,
          periodStart: result.paymentFailed.periodStart,
          status: result.paymentFailed.status,
          reason: result.paymentFailed.reason,
        });
      }
    }
    res.status(204).end();
  });

  return router;
}
