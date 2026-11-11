import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GOCARDLESS_API_VERSION,
  GoCardlessApiError,
  GoCardlessPaymentsProvider,
} from "./gocardless.ts";
import { PaymentsWebhookError } from "./payments.ts";

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A GoCardless that answers each request in turn with the given status and JSON body. */
function stub(answers: { status: number; json: unknown }[]) {
  const requests: Seen[] = [];
  const fetchStub: typeof fetch = (input, init) => {
    requests.push({
      method: init?.method ?? "GET",
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const answer = answers.shift() ?? { status: 500, json: { error: { message: "no answer" } } };
    return Promise.resolve(Response.json(answer.json, { status: answer.status }));
  };
  return { fetch: fetchStub, requests };
}

const provider = (api: { fetch: typeof fetch }, webhookSecret?: string) =>
  new GoCardlessPaymentsProvider({
    accessToken: "sandbox_token",
    environment: "sandbox",
    webhookSecret,
    fetch: api.fetch,
  });

describe("GoCardlessPaymentsProvider", () => {
  it("starts a mandate set-up with a billing request then its hosted flow, keyed for retries", async () => {
    const api = stub([
      { status: 201, json: { billing_requests: { id: "BRQ1", status: "pending", links: {} } } },
      {
        status: 201,
        json: {
          billing_request_flows: {
            id: "BRF1",
            authorisation_url: "https://pay-sandbox.gocardless.com/billing/static/flow?id=BRF1",
            expires_at: "2026-11-17T12:00:00.000Z",
          },
        },
      },
    ]);
    const setup = await provider(api).startMandateSetup({
      businessName: "Wren Plumbing",
      email: "wren@example.com",
      redirectUrl: "https://app.example/billing/done",
      exitUrl: "https://app.example/billing",
      metadata: { tenantId: "t1" },
      idempotencyKey: "setup:t1:1",
    });
    expect(setup).toEqual({
      setupRef: "BRQ1",
      authorisationUrl: "https://pay-sandbox.gocardless.com/billing/static/flow?id=BRF1",
      expiresAt: new Date("2026-11-17T12:00:00.000Z"),
    });
    expect(api.requests).toHaveLength(2);
    expect(api.requests[0]).toMatchObject({
      method: "POST",
      url: "https://api-sandbox.gocardless.com/billing_requests",
      headers: {
        Authorization: "Bearer sandbox_token",
        "GoCardless-Version": GOCARDLESS_API_VERSION,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": "setup:t1:1",
      },
      body: {
        billing_requests: {
          mandate_request: { scheme: "bacs", currency: "GBP" },
          metadata: { tenantId: "t1" },
        },
      },
    });
    // The flow is only a URL to the request, so it carries no key: a second is harmless.
    expect(api.requests[1]?.headers).not.toHaveProperty("Idempotency-Key");
    expect(api.requests[1]).toMatchObject({
      url: "https://api-sandbox.gocardless.com/billing_request_flows",
      body: {
        billing_request_flows: {
          redirect_uri: "https://app.example/billing/done",
          exit_uri: "https://app.example/billing",
          prefilled_customer: { company_name: "Wren Plumbing", email: "wren@example.com" },
          links: { billing_request: "BRQ1" },
        },
      },
    });
  });

  it("reads a set-up's state: pending, fulfilled with its mandate, or cancelled", async () => {
    const api = stub([
      { status: 200, json: { billing_requests: { id: "BRQ1", status: "pending", links: {} } } },
      {
        status: 200,
        json: { billing_requests: { id: "BRQ1", status: "fulfilled", links: { mandate: "MD1" } } },
      },
      { status: 200, json: { billing_requests: { id: "BRQ1", status: "cancelled", links: {} } } },
    ]);
    const p = provider(api);
    expect(await p.mandateSetupState("BRQ1")).toEqual({ status: "pending", mandateRef: null });
    expect(await p.mandateSetupState("BRQ1")).toEqual({ status: "fulfilled", mandateRef: "MD1" });
    expect(await p.mandateSetupState("BRQ1")).toEqual({ status: "cancelled", mandateRef: null });
    expect(api.requests[0]).toMatchObject({
      method: "GET",
      url: "https://api-sandbox.gocardless.com/billing_requests/BRQ1",
    });
    expect(api.requests[0]?.headers).not.toHaveProperty("Content-Type");
  });

  it("creates a payment in whole pence against the mandate, with the idempotency key", async () => {
    const api = stub([
      {
        status: 201,
        json: { payments: { id: "PM1", status: "pending_submission", charge_date: "2026-11-13" } },
      },
    ]);
    const receipt = await provider(api).createPayment({
      mandateRef: "MD1",
      amountPence: 9920,
      description: "AnswerMate, 14 Oct to 13 Nov",
      metadata: { tenantId: "t1", periodStart: "2026-10-14" },
      idempotencyKey: "charge:t1:2026-10-14",
    });
    expect(receipt).toEqual({
      paymentRef: "PM1",
      status: "pending_submission",
      chargeDate: "2026-11-13",
    });
    expect(api.requests[0]).toMatchObject({
      url: "https://api-sandbox.gocardless.com/payments",
      headers: { "Idempotency-Key": "charge:t1:2026-10-14" },
      body: {
        payments: {
          amount: 9920,
          currency: "GBP",
          description: "AnswerMate, 14 Oct to 13 Nov",
          links: { mandate: "MD1" },
        },
      },
    });
  });

  it("refuses an amount that isn't whole pence above zero, before any request", async () => {
    const api = stub([]);
    const request = {
      mandateRef: "MD1",
      description: "x",
      metadata: {},
      idempotencyKey: "k",
    };
    await expect(provider(api).createPayment({ ...request, amountPence: 99.5 })).rejects.toThrow(
      /whole number of pence/,
    );
    await expect(provider(api).createPayment({ ...request, amountPence: 0 })).rejects.toThrow();
    expect(api.requests).toHaveLength(0);
  });

  it("turns an error answer into a GoCardlessApiError with the status and type, redacted", async () => {
    const api = stub([
      {
        status: 422,
        json: {
          error: {
            type: "validation_failed",
            code: 422,
            message: "Validation failed",
            errors: [{ field: "email", message: "wren@example.com is not valid" }],
          },
        },
      },
    ]);
    const error = await provider(api)
      .mandateSetupState("BRQ1")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoCardlessApiError);
    expect(error).toMatchObject({ status: 422, type: "validation_failed" });
    expect((error as Error).message).toContain("HTTP 422");
    expect((error as Error).message).not.toContain("wren@example.com");
  });

  it("treats cancelling a mandate that's already cancelled as done", async () => {
    const api = stub([
      { status: 200, json: { mandates: { id: "MD1", status: "cancelled" } } },
      {
        status: 422,
        json: {
          error: { type: "invalid_state", code: 422, message: "Mandate is already cancelled" },
        },
      },
      {
        status: 401,
        json: { error: { type: "invalid_api_usage", code: 401, message: "bad token" } },
      },
    ]);
    const p = provider(api);
    await expect(p.cancelMandate("MD1")).resolves.toBeUndefined();
    await expect(p.cancelMandate("MD1")).resolves.toBeUndefined();
    await expect(p.cancelMandate("MD1")).rejects.toMatchObject({ status: 401 });
    expect(api.requests[0]).toMatchObject({
      method: "POST",
      url: "https://api-sandbox.gocardless.com/mandates/MD1/actions/cancel",
    });
  });

  // The sandbox's actual answer to a repeated key (2026-11-10): 409, naming the first resource.
  it("fetches the original when a repeated idempotency key is refused with 409", async () => {
    const conflict = (id: string) => ({
      status: 409,
      json: {
        error: {
          type: "invalid_api_usage",
          code: 409,
          message: "A resource has already been created with this idempotency key",
          errors: [
            {
              reason: "idempotent_creation_conflict",
              message: "A resource has already been created with this idempotency key",
              links: { conflicting_resource_id: id },
            },
          ],
        },
      },
    });
    const api = stub([
      conflict("PM9"),
      {
        status: 200,
        json: { payments: { id: "PM9", status: "submitted", charge_date: "2026-11-13" } },
      },
      conflict("BRQ9"),
      { status: 200, json: { billing_requests: { id: "BRQ9", status: "pending", links: {} } } },
      {
        status: 201,
        json: {
          billing_request_flows: {
            id: "BRF2",
            authorisation_url: "https://pay-sandbox.gocardless.com/billing/static/flow?id=BRF2",
            expires_at: "2026-11-17T12:00:00.000Z",
          },
        },
      },
    ]);
    const p = provider(api);
    expect(
      await p.createPayment({
        mandateRef: "MD1",
        amountPence: 9900,
        description: "x",
        metadata: {},
        idempotencyKey: "charge:again",
      }),
    ).toEqual({ paymentRef: "PM9", status: "submitted", chargeDate: "2026-11-13" });
    expect(api.requests[1]).toMatchObject({
      method: "GET",
      url: "https://api-sandbox.gocardless.com/payments/PM9",
    });
    expect(
      await p.startMandateSetup({
        businessName: "B",
        redirectUrl: "https://a/b",
        exitUrl: "https://a/c",
        metadata: {},
        idempotencyKey: "setup:again",
      }),
    ).toMatchObject({ setupRef: "BRQ9" });
    expect(api.requests[3]).toMatchObject({
      method: "GET",
      url: "https://api-sandbox.gocardless.com/billing_requests/BRQ9",
    });
  });

  it("gives up on a request GoCardless never answers", async () => {
    const hung: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason as Error));
      });
    const p = new GoCardlessPaymentsProvider({
      accessToken: "t",
      environment: "sandbox",
      fetch: hung,
      timeoutMs: 20,
    });
    await expect(p.mandateSetupState("BRQ1")).rejects.toThrow(/timeout|aborted/i);
  });
});

describe("GoCardless webhooks", () => {
  const secret = "whsec_test";
  const body = Buffer.from(
    JSON.stringify({
      events: [
        {
          id: "EV1",
          created_at: "2026-11-10T12:00:00.000Z",
          resource_type: "payments",
          action: "failed",
          details: {
            origin: "bank",
            cause: "insufficient_funds",
            description: "Insufficient funds",
          },
          links: { payment: "PM1" },
        },
        {
          id: "EV2",
          created_at: "2026-11-10T12:00:01.000Z",
          resource_type: "payouts",
          action: "paid",
          links: { payout: "PO1" },
        },
      ],
    }),
  );
  const sign = (bytes: Buffer, key = secret) =>
    createHmac("sha256", key).update(bytes).digest("hex");

  it("verifies the signature over the raw body and reports each event", () => {
    const events = provider(stub([]), secret).verifyAndParseWebhook(body, {
      "webhook-signature": sign(body),
    });
    expect(events).toEqual([
      {
        id: "EV1",
        resourceType: "payments",
        action: "failed",
        cause: "insufficient_funds",
        description: "Insufficient funds",
        links: { payment: "PM1", mandate: undefined, billingRequest: undefined },
        createdAt: new Date("2026-11-10T12:00:00.000Z"),
      },
      expect.objectContaining({ id: "EV2", resourceType: "other", action: "paid" }),
    ]);
  });

  it("refuses a bad, missing or differently-keyed signature, and a body changed after signing", () => {
    const p = provider(stub([]), secret);
    expect(() => p.verifyAndParseWebhook(body, {})).toThrow(PaymentsWebhookError);
    expect(() => p.verifyAndParseWebhook(body, { "webhook-signature": "nope" })).toThrow(
      PaymentsWebhookError,
    );
    expect(() =>
      p.verifyAndParseWebhook(body, { "webhook-signature": sign(body, "other") }),
    ).toThrow(PaymentsWebhookError);
    const tampered = Buffer.from(body.toString("utf8").replace("PM1", "PM2"));
    expect(() => p.verifyAndParseWebhook(tampered, { "webhook-signature": sign(body) })).toThrow(
      PaymentsWebhookError,
    );
  });

  it("reports the mandate a fulfilled billing request created", () => {
    const fulfilled = Buffer.from(
      JSON.stringify({
        events: [
          {
            id: "EV3",
            created_at: "2026-11-10T12:00:00.000Z",
            resource_type: "billing_requests",
            action: "fulfilled",
            details: { cause: "billing_request_fulfilled" },
            links: { billing_request: "BRQ1", mandate_request_mandate: "MD7" },
          },
        ],
      }),
    );
    const [event] = provider(stub([]), secret).verifyAndParseWebhook(fulfilled, {
      "webhook-signature": sign(fulfilled),
    });
    expect(event).toMatchObject({
      resourceType: "billing_requests",
      action: "fulfilled",
      links: { billingRequest: "BRQ1", mandate: "MD7" },
    });
  });

  it("refuses every webhook until a secret is configured", () => {
    expect(() =>
      provider(stub([])).verifyAndParseWebhook(body, { "webhook-signature": sign(body) }),
    ).toThrow(/No webhook secret/);
  });
});

// Against the real sandbox, which costs nothing and moves no money: run with
// GOCARDLESS_SANDBOX_TESTS=1 and GOCARDLESS_ACCESS_TOKEN (a sandbox token) in the environment.
describe.runIf(process.env.GOCARDLESS_SANDBOX_TESTS === "1" && process.env.GOCARDLESS_ACCESS_TOKEN)(
  "GoCardless sandbox",
  () => {
    const live = () =>
      new GoCardlessPaymentsProvider({
        accessToken: process.env.GOCARDLESS_ACCESS_TOKEN!,
        environment: "sandbox",
      });

    it("creates a mandate set-up and reads it back as pending", async () => {
      const key = `test:${Date.now()}`;
      const setup = await live().startMandateSetup({
        businessName: "Wren Plumbing (test)",
        redirectUrl: "https://example.com/billing/done",
        exitUrl: "https://example.com/billing",
        metadata: { tenantId: "test" },
        idempotencyKey: key,
      });
      expect(setup.setupRef).toMatch(/^BRQ/);
      expect(setup.authorisationUrl).toMatch(/^https:\/\/pay(-sandbox)?\.gocardless\.com\//);
      expect(setup.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(await live().mandateSetupState(setup.setupRef)).toEqual({
        status: "pending",
        mandateRef: null,
      });
      // The same key makes nothing new.
      const again = await live().startMandateSetup({
        businessName: "Wren Plumbing (test)",
        redirectUrl: "https://example.com/billing/done",
        exitUrl: "https://example.com/billing",
        metadata: { tenantId: "test" },
        idempotencyKey: key,
      });
      expect(again.setupRef).toBe(setup.setupRef);
    }, 30_000);

    it("reports a payment against a mandate that doesn't exist as the provider's error", async () => {
      const error = await live()
        .createPayment({
          mandateRef: "MD000000000000",
          amountPence: 100,
          description: "test",
          metadata: {},
          idempotencyKey: `test:payment:${Date.now()}`,
        })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GoCardlessApiError);
      expect([404, 422]).toContain((error as GoCardlessApiError).status);
    }, 30_000);
  },
);
