import { createHmac, randomUUID } from "node:crypto";
import {
  PaymentsWebhookError,
  type MandateSetup,
  type MandateSetupRequest,
  type MandateSetupState,
  type PaymentReceipt,
  type PaymentRequest,
  type PaymentsEvent,
  type PaymentsProvider,
  type WebhookHeaders,
} from "./payments.ts";

/**
 * An in-memory PaymentsProvider for tests: records every set-up and payment, lets a test
 * "complete" a set-up as the person would on the hosted page, can be told to fail, and signs
 * webhooks the way GoCardless does (HMAC-SHA256 of the body, hex) so route tests verify them.
 */
export class FakePaymentsProvider implements PaymentsProvider {
  readonly webhookSecret = "fake-webhook-secret";
  readonly setups = new Map<string, MandateSetupRequest & MandateSetupState>();
  readonly payments: (PaymentRequest & PaymentReceipt)[] = [];
  readonly cancelledMandates: string[] = [];
  private failures: (string | Error)[] = [];
  private readonly byIdempotencyKey = new Map<string, string>();

  /** The next call rejects with this message, or with this error (one with a `status`, say). */
  willFail(failure: string | Error) {
    this.failures.push(failure);
    return this;
  }

  private failIfTold(): void {
    const failure = this.failures.shift();
    if (failure !== undefined) throw typeof failure === "string" ? new Error(failure) : failure;
  }

  async startMandateSetup(request: MandateSetupRequest): Promise<MandateSetup> {
    await Promise.resolve();
    this.failIfTold();
    const existing = this.byIdempotencyKey.get(request.idempotencyKey);
    const setupRef = existing ?? `BRQ${randomUUID().replace(/-/g, "").slice(0, 14)}`;
    if (!existing) {
      this.byIdempotencyKey.set(request.idempotencyKey, setupRef);
      this.setups.set(setupRef, { ...request, status: "pending", mandateRef: null });
    }
    return {
      setupRef,
      authorisationUrl: `https://pay.fake.invalid/billing/static/flow?id=${setupRef}`,
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    };
  }

  /** What the person does on the hosted page: completes the set-up, which makes a mandate. */
  completeSetup(setupRef: string): string {
    const setup = this.setups.get(setupRef);
    if (!setup) throw new Error(`No set-up ${setupRef}`);
    const mandateRef = `MD${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    this.setups.set(setupRef, { ...setup, status: "fulfilled", mandateRef });
    return mandateRef;
  }

  cancelSetup(setupRef: string): void {
    const setup = this.setups.get(setupRef);
    if (setup) this.setups.set(setupRef, { ...setup, status: "cancelled" });
  }

  async mandateSetupState(setupRef: string): Promise<MandateSetupState> {
    await Promise.resolve();
    this.failIfTold();
    const setup = this.setups.get(setupRef);
    if (!setup) throw new Error(`No set-up ${setupRef}`);
    return { status: setup.status, mandateRef: setup.mandateRef };
  }

  async createPayment(request: PaymentRequest): Promise<PaymentReceipt> {
    await Promise.resolve();
    // As strict as the GoCardless adapter, so a test can't pass with an amount the real one
    // would refuse.
    if (!Number.isInteger(request.amountPence) || request.amountPence <= 0) {
      throw new Error("A payment's amount must be a whole number of pence above zero");
    }
    this.failIfTold();
    const existing = this.payments.find((p) => p.idempotencyKey === request.idempotencyKey);
    if (existing) {
      return {
        paymentRef: existing.paymentRef,
        status: existing.status,
        chargeDate: existing.chargeDate,
      };
    }
    const receipt: PaymentReceipt = {
      paymentRef: `PM${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      status: "pending_submission",
      chargeDate: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10),
    };
    this.payments.push({ ...request, ...receipt });
    return receipt;
  }

  async cancelMandate(mandateRef: string): Promise<void> {
    await Promise.resolve();
    this.failIfTold();
    this.cancelledMandates.push(mandateRef);
  }

  readonly retried: string[] = [];

  async retryPayment(paymentRef: string): Promise<{ status: string }> {
    await Promise.resolve();
    this.failIfTold();
    this.retried.push(paymentRef);
    return { status: "submitted" };
  }

  /** A signed webhook request for events, as the provider would send it. */
  webhookFor(events: PaymentsEvent[]): { rawBody: Buffer; headers: WebhookHeaders } {
    const rawBody = Buffer.from(
      JSON.stringify({
        events: events.map((event) => ({
          id: event.id,
          created_at: event.createdAt.toISOString(),
          resource_type: event.resourceType,
          action: event.action,
          details: { cause: event.cause, description: event.description },
          links: {
            ...(event.links.payment && { payment: event.links.payment }),
            ...(event.links.mandate && { mandate: event.links.mandate }),
            ...(event.links.billingRequest && { billing_request: event.links.billingRequest }),
            ...(event.links.newMandate && { new_mandate: event.links.newMandate }),
          },
        })),
      }),
    );
    return { rawBody, headers: { "webhook-signature": this.sign(rawBody) } };
  }

  sign(rawBody: Buffer): string {
    return createHmac("sha256", this.webhookSecret).update(rawBody).digest("hex");
  }

  verifyAndParseWebhook(rawBody: Buffer, headers: WebhookHeaders): PaymentsEvent[] {
    const given = headers["webhook-signature"];
    if (typeof given !== "string" || given !== this.sign(rawBody)) {
      throw new PaymentsWebhookError("Invalid webhook signature");
    }
    const body = JSON.parse(rawBody.toString("utf8")) as {
      events: {
        id: string;
        created_at: string;
        resource_type: string;
        action: string;
        details?: { cause?: string | null; description?: string | null };
        links?: {
          payment?: string;
          mandate?: string;
          billing_request?: string;
          new_mandate?: string;
        };
      }[];
    };
    return body.events.map((event) => ({
      id: event.id,
      resourceType:
        event.resource_type === "payments" ||
        event.resource_type === "mandates" ||
        event.resource_type === "billing_requests"
          ? event.resource_type
          : "other",
      action: event.action,
      cause: event.details?.cause ?? null,
      description: event.details?.description ?? null,
      links: {
        payment: event.links?.payment,
        mandate: event.links?.mandate,
        billingRequest: event.links?.billing_request,
        newMandate: event.links?.new_mandate,
      },
      createdAt: new Date(event.created_at),
    }));
  }
}
