// GoCardless adapter (decision 019). Its API reference was read on 2026-11-10
// (docs.gocardless.com/api-reference): bearer token, the GoCardless-Version header (one
// released version, 2015-07-06), JSON bodies nested under the resource's name, an
// Idempotency-Key on anything that creates, and webhooks signed with HMAC-SHA256 of the raw
// body in Webhook-Signature. Sandbox and live are different hosts with different tokens.
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { redactText } from "../redact.ts";
import {
  MandateUnusableError,
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

export const GOCARDLESS_API_VERSION = "2015-07-06";

export const GOCARDLESS_HOSTS = {
  sandbox: "https://api-sandbox.gocardless.com",
  live: "https://api.gocardless.com",
} as const;

export type GoCardlessEnvironment = keyof typeof GOCARDLESS_HOSTS;

export interface GoCardlessOptions {
  accessToken: string;
  environment: GoCardlessEnvironment;
  /** The endpoint's secret from Developers > Webhooks; without it, webhooks are refused. */
  webhookSecret?: string | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class GoCardlessApiError extends Error {
  override readonly name = "GoCardlessApiError";
  readonly status: number;
  /** GoCardless's own type: "validation_failed", "invalid_state", "invalid_api_usage", "gocardless". */
  readonly type: string | null;
  /** Each error's reason code ("retry_failed", "cancellation_failed", "mandate_is_inactive"...). */
  readonly reasons: readonly string[];

  constructor(
    status: number,
    path: string,
    type: string | null,
    detail: string,
    reasons: readonly string[] = [],
  ) {
    // The provider's own words can quote a name or an address. Errors are logged, and stored
    // with failed jobs in the queue's tables, so the detail is redacted here, once.
    super(`GoCardless ${redactText(path)} failed: HTTP ${status} ${redactText(detail)}`);
    this.status = status;
    this.type = type;
    this.reasons = reasons;
  }
}

const errorBodySchema = z.object({
  error: z.object({
    type: z.string().optional(),
    message: z.string().optional(),
    errors: z
      .array(
        z.object({
          message: z.string().optional(),
          field: z.string().optional(),
          reason: z.string().optional(),
          links: z.object({ conflicting_resource_id: z.string().optional() }).optional(),
        }),
      )
      .optional(),
  }),
});

/**
 * A create repeated with the same Idempotency-Key: GoCardless answers 409 and names the
 * resource the first call made (the sandbox confirmed it, 2026-11-10), rather than returning
 * it again. The adapter fetches that resource, so a retry gets the same answer as the original.
 */
class IdempotentCreationConflict extends Error {
  override readonly name = "IdempotentCreationConflict";
  readonly conflictingResourceId: string;

  constructor(conflictingResourceId: string) {
    super(`A resource already exists for this idempotency key: ${conflictingResourceId}`);
    this.conflictingResourceId = conflictingResourceId;
  }
}

const billingRequestSchema = z.object({
  billing_requests: z.object({
    id: z.string(),
    status: z.string(),
    links: z.object({ mandate: z.string().optional() }).passthrough().optional(),
  }),
});

const billingRequestFlowSchema = z.object({
  billing_request_flows: z.object({
    id: z.string(),
    authorisation_url: z.string(),
    expires_at: z.string(),
  }),
});

const paymentSchema = z.object({
  payments: z.object({ id: z.string(), status: z.string(), charge_date: z.string() }),
});

const webhookSchema = z.object({
  events: z.array(
    z.object({
      id: z.string(),
      created_at: z.string(),
      resource_type: z.string(),
      action: z.string(),
      details: z
        .object({ cause: z.string().nullish(), description: z.string().nullish() })
        .passthrough()
        .optional(),
      links: z
        .object({
          payment: z.string().optional(),
          mandate: z.string().optional(),
          billing_request: z.string().optional(),
          // On a billing request's event: "the ID of the mandate which has been created".
          mandate_request_mandate: z.string().optional(),
          // On a mandate's "replaced" event: the mandate that takes over.
          new_mandate: z.string().optional(),
        })
        .passthrough()
        .optional(),
    }),
  ),
});

export class GoCardlessPaymentsProvider implements PaymentsProvider {
  private readonly options: GoCardlessOptions;

  constructor(options: GoCardlessOptions) {
    this.options = options;
  }

  async startMandateSetup(request: MandateSetupRequest): Promise<MandateSetup> {
    // Two calls: the request (what's being asked for: a Bacs mandate), then the hosted flow
    // for it, which is what the person is sent to. The request carries the idempotency key,
    // so a retry finds the one already made; the flow is only a fresh URL to that request,
    // so a second one is harmless, and flows can't be fetched back by ID anyway.
    const created = await this.call(
      "POST",
      "/billing_requests",
      {
        billing_requests: {
          mandate_request: { scheme: "bacs", currency: "GBP" },
          metadata: request.metadata,
        },
      },
      billingRequestSchema,
      request.idempotencyKey,
    ).catch((error: unknown) => {
      if (!(error instanceof IdempotentCreationConflict)) throw error;
      return this.call(
        "GET",
        `/billing_requests/${encodeURIComponent(error.conflictingResourceId)}`,
        undefined,
        billingRequestSchema,
      );
    });
    const flow = await this.call(
      "POST",
      "/billing_request_flows",
      {
        billing_request_flows: {
          redirect_uri: request.redirectUrl,
          exit_uri: request.exitUrl,
          prefilled_customer: {
            company_name: request.businessName,
            ...(request.email !== undefined && { email: request.email }),
          },
          links: { billing_request: created.billing_requests.id },
        },
      },
      billingRequestFlowSchema,
    );
    return {
      setupRef: created.billing_requests.id,
      authorisationUrl: flow.billing_request_flows.authorisation_url,
      expiresAt: new Date(flow.billing_request_flows.expires_at),
    };
  }

  async mandateSetupState(setupRef: string): Promise<MandateSetupState> {
    const found = await this.call(
      "GET",
      `/billing_requests/${encodeURIComponent(setupRef)}`,
      undefined,
      billingRequestSchema,
    );
    const { status, links } = found.billing_requests;
    const mandateRef = links?.mandate ?? null;
    if (status === "fulfilled" && mandateRef) return { status: "fulfilled", mandateRef };
    if (status === "cancelled") return { status: "cancelled", mandateRef: null };
    return { status: "pending", mandateRef: null };
  }

  async createPayment(request: PaymentRequest): Promise<PaymentReceipt> {
    if (!Number.isInteger(request.amountPence) || request.amountPence <= 0) {
      throw new Error("A payment's amount must be a whole number of pence above zero");
    }
    const created = await this.call(
      "POST",
      "/payments",
      {
        payments: {
          amount: request.amountPence,
          currency: "GBP",
          description: request.description,
          metadata: request.metadata,
          links: { mandate: request.mandateRef },
        },
      },
      paymentSchema,
      request.idempotencyKey,
    ).catch((error: unknown) => {
      // A retry of a payment already made: the same receipt, never a second payment.
      if (error instanceof IdempotentCreationConflict) {
        return this.call(
          "GET",
          `/payments/${encodeURIComponent(error.conflictingResourceId)}`,
          undefined,
          paymentSchema,
        );
      }
      // "invalid_state" on a new payment is the mandate: cancelled, failed or expired
      // (GoCardless's "mandate_is_inactive"). Anything else (a bad token, a validation error)
      // is ours to fix, and stays a GoCardlessApiError.
      if (error instanceof GoCardlessApiError && error.type === "invalid_state") {
        throw new MandateUnusableError(error.message);
      }
      throw error;
    });
    return {
      paymentRef: created.payments.id,
      status: created.payments.status,
      chargeDate: created.payments.charge_date,
    };
  }

  async cancelMandate(mandateRef: string): Promise<void> {
    try {
      await this.call(
        "POST",
        `/mandates/${encodeURIComponent(mandateRef)}/actions/cancel`,
        { data: {} },
        z.object({}).passthrough(),
      );
    } catch (error) {
      // Already cancelled (or never active): GoCardless refuses with "cancellation_failed"
      // (its docs) as an invalid state, which for "make sure it's cancelled" is success.
      if (
        error instanceof GoCardlessApiError &&
        (error.type === "invalid_state" || error.reasons.includes("cancellation_failed"))
      ) {
        return;
      }
      throw error;
    }
  }

  async retryPayment(paymentRef: string): Promise<{ status: string }> {
    // Only a failed payment can be retried, and only while its mandate is active; GoCardless
    // refuses anything else ("retry_failed"), which stays a GoCardlessApiError for the caller.
    const retried = await this.call(
      "POST",
      `/payments/${encodeURIComponent(paymentRef)}/actions/retry`,
      { data: {} },
      paymentSchema,
    );
    return { status: retried.payments.status };
  }

  verifyAndParseWebhook(rawBody: Buffer, headers: WebhookHeaders): PaymentsEvent[] {
    const secret = this.options.webhookSecret;
    if (!secret) throw new PaymentsWebhookError("No webhook secret is configured");
    const given = headers["webhook-signature"];
    const expected = Buffer.from(createHmac("sha256", secret).update(rawBody).digest("hex"));
    // Byte lengths, not string lengths: a header of the right length in other characters is
    // longer in bytes, and timingSafeEqual would throw rather than say no.
    const givenBytes = Buffer.from(typeof given === "string" ? given : "");
    if (
      typeof given !== "string" ||
      givenBytes.length !== expected.length ||
      !timingSafeEqual(givenBytes, expected)
    ) {
      throw new PaymentsWebhookError("Missing or invalid Webhook-Signature");
    }
    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new PaymentsWebhookError("Webhook body is not JSON");
    }
    const parsed = webhookSchema.safeParse(json);
    if (!parsed.success) throw new PaymentsWebhookError("Malformed webhook body");
    return parsed.data.events.map((event) => ({
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
        mandate: event.links?.mandate ?? event.links?.mandate_request_mandate,
        billingRequest: event.links?.billing_request,
        newMandate: event.links?.new_mandate,
      },
      createdAt: new Date(event.created_at),
    }));
  }

  private async call<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
    idempotencyKey?: string,
  ): Promise<T> {
    const response = await (this.options.fetch ?? fetch)(
      `${GOCARDLESS_HOSTS[this.options.environment]}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.options.accessToken}`,
          "GoCardless-Version": GOCARDLESS_API_VERSION,
          Accept: "application/json",
          ...(body !== undefined && { "Content-Type": "application/json" }),
          ...(idempotencyKey !== undefined && { "Idempotency-Key": idempotencyKey }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      },
    );
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      // A non-JSON body (a gateway page, say): the status is all we have.
    }
    if (!response.ok) {
      const parsed = errorBodySchema.safeParse(json);
      const conflicting = parsed.success
        ? parsed.data.error.errors?.find((e) => e.links?.conflicting_resource_id)?.links
            ?.conflicting_resource_id
        : undefined;
      if (response.status === 409 && conflicting) {
        throw new IdempotentCreationConflict(conflicting);
      }
      const detail = parsed.success
        ? [parsed.data.error.message, ...(parsed.data.error.errors ?? []).map((e) => e.message)]
            .filter((part): part is string => typeof part === "string")
            .join("; ")
        : "no message";
      throw new GoCardlessApiError(
        response.status,
        path,
        parsed.success ? (parsed.data.error.type ?? null) : null,
        detail.slice(0, 200),
        parsed.success
          ? (parsed.data.error.errors ?? []).flatMap((e) => (e.reason ? [e.reason] : []))
          : [],
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new GoCardlessApiError(response.status, path, null, "unexpected response shape");
    }
    return parsed.data;
  }
}
