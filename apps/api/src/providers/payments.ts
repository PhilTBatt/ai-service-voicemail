// The seam between CallMate and the payments provider (decision 019: GoCardless Direct
// Debit; a fake for tests). Money is integer pence. The caller decides what to charge
// (core/billing.ts); the adapter only talks to the provider.

/** A mandate set-up started for a business: where to send them, and what to look up after. */
export interface MandateSetup {
  /** The provider's reference for the set-up itself (GoCardless: the billing request ID). */
  setupRef: string;
  /** The hosted page the person is sent to, to give their bank details. */
  authorisationUrl: string;
  expiresAt: Date;
}

export interface MandateSetupRequest {
  /** Shown on the hosted page and the mandate: the business's name. */
  businessName: string;
  /** Pre-fills the page; the person can change it. */
  email?: string | undefined;
  /** Where the person lands after completing, and if they abandon. */
  redirectUrl: string;
  exitUrl: string;
  /** Ours, to find the business again from the provider's webhooks. */
  metadata: Record<string, string>;
  /** Makes a retried request create nothing twice (providers honour it for at least 30 days). */
  idempotencyKey: string;
}

export interface MandateSetupState {
  status: "pending" | "fulfilled" | "cancelled";
  /** The mandate to collect against, once the set-up is fulfilled. */
  mandateRef: string | null;
}

export interface PaymentRequest {
  mandateRef: string;
  amountPence: number;
  /** What the person sees on their bank statement and the provider's emails. */
  description: string;
  metadata: Record<string, string>;
  idempotencyKey: string;
}

export interface PaymentReceipt {
  paymentRef: string;
  /** The provider's status at creation: usually waiting to be submitted to the bank. */
  status: string;
  /** The day the money is collected (YYYY-MM-DD), decided by the provider. */
  chargeDate: string;
}

/** One event from the provider's webhook, as this seam reports it. */
export interface PaymentsEvent {
  /** The provider's ID for the event: the idempotency key for handling it. */
  id: string;
  resourceType: "payments" | "mandates" | "billing_requests" | "other";
  /** The provider's own action name ("confirmed", "failed", "cancelled", "fulfilled"...). */
  action: string;
  /** The provider's reason code for the action, when it gives one. */
  cause: string | null;
  description: string | null;
  links: {
    payment?: string | undefined;
    mandate?: string | undefined;
    billingRequest?: string | undefined;
  };
  createdAt: Date;
}

export interface WebhookHeaders {
  [name: string]: string | string[] | undefined;
}

export class PaymentsWebhookError extends Error {
  override readonly name = "PaymentsWebhookError";
}

export interface PaymentsProvider {
  /** Starts a mandate set-up: creates the request and the hosted flow for it. */
  startMandateSetup(request: MandateSetupRequest): Promise<MandateSetup>;
  /** Where a set-up has got to: fulfilled with a mandate, still pending, or cancelled. */
  mandateSetupState(setupRef: string): Promise<MandateSetupState>;
  /** Collects a payment against a mandate. Safe to retry with the same idempotency key. */
  createPayment(request: PaymentRequest): Promise<PaymentReceipt>;
  /** Cancels a mandate (a business leaving, Step 13). Safe to repeat. */
  cancelMandate(mandateRef: string): Promise<void>;
  /**
   * Verifies a webhook's signature over the exact bytes received and returns its events.
   * Throws PaymentsWebhookError for a bad or missing signature, or a malformed body.
   */
  verifyAndParseWebhook(rawBody: Buffer, headers: WebhookHeaders): PaymentsEvent[];
}
