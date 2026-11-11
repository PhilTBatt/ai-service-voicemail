// The GoCardless adapter at its edges, against a stubbed API (no network): amounts that aren't
// whole pence, answers that aren't what was expected, refusals of every kind, and webhook
// bodies and headers GoCardless wouldn't send. And the fake, which tests elsewhere stand on,
// refusing the same amounts the adapter does.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GoCardlessApiError, GoCardlessPaymentsProvider } from "./gocardless.ts";
import { FakePaymentsProvider } from "./payments.fake.ts";
import { MandateUnusableError, PaymentsWebhookError, type PaymentRequest } from "./payments.ts";

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A GoCardless that answers each request in turn; a string answer is sent as a non-JSON body. */
function stub(answers: { status: number; json?: unknown; text?: string }[]) {
  const requests: Seen[] = [];
  const fetchStub: typeof fetch = (input, init) => {
    requests.push({
      method: init?.method ?? "GET",
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const answer = answers.shift() ?? { status: 500, json: { error: { message: "no answer" } } };
    return Promise.resolve(
      answer.text !== undefined
        ? new Response(answer.text, { status: answer.status })
        : Response.json(answer.json, { status: answer.status }),
    );
  };
  return { fetch: fetchStub, requests };
}

const SECRET = "whsec_fictional";
const provider = (api: { fetch: typeof fetch }) =>
  new GoCardlessPaymentsProvider({
    accessToken: "fictional_token",
    environment: "sandbox",
    webhookSecret: SECRET,
    fetch: api.fetch,
  });

const payment = (amountPence: number): PaymentRequest => ({
  mandateRef: "MD_FICTIONAL",
  amountPence,
  description: "AnswerMate, 14 Sep 2026 to 13 Oct 2026",
  metadata: { tenantId: "t", periodStart: "2026-09-14" },
  idempotencyKey: "charge:t:2026-09-14",
});

const created = {
  status: 201,
  json: { payments: { id: "PM1", status: "pending_submission", charge_date: "2026-10-19" } },
};

describe("amounts", () => {
  it.each([0, -1, -9900, 0.5, 99.5, 9900.01, Number.NaN, Infinity, -Infinity])(
    "refuses %s pence before asking GoCardless, and so does the fake",
    async (amount) => {
      const api = stub([created]);
      await expect(provider(api).createPayment(payment(amount))).rejects.toThrow(
        /whole number of pence above zero/,
      );
      expect(api.requests).toEqual([]);
      const fake = new FakePaymentsProvider();
      await expect(fake.createPayment(payment(amount))).rejects.toThrow(
        /whole number of pence above zero/,
      );
      expect(fake.payments).toEqual([]);
    },
  );

  it.each([1, 100, 9900, 11_928, 2_147_483_647])(
    "sends %s pence as that whole number, in pounds sterling, against the mandate",
    async (amount) => {
      const api = stub([created]);
      await provider(api).createPayment(payment(amount));
      expect(api.requests[0]?.body).toEqual({
        payments: {
          amount,
          currency: "GBP",
          description: "AnswerMate, 14 Sep 2026 to 13 Oct 2026",
          metadata: { tenantId: "t", periodStart: "2026-09-14" },
          links: { mandate: "MD_FICTIONAL" },
        },
      });
      expect(api.requests[0]?.headers["Idempotency-Key"]).toBe("charge:t:2026-09-14");
    },
  );

  it("sends the same idempotency key every time the same month is asked for", async () => {
    const api = stub([created, created]);
    const p = provider(api);
    await p.createPayment(payment(9900));
    await p.createPayment(payment(9900));
    expect(api.requests.map((r) => r.headers["Idempotency-Key"])).toEqual([
      "charge:t:2026-09-14",
      "charge:t:2026-09-14",
    ]);
  });
});

describe("answers that aren't what was asked for", () => {
  it("treats a success it can't read as a failure, never as a payment without an ID", async () => {
    for (const json of [
      { payments: { status: "pending_submission", charge_date: "2026-10-19" } },
      { payments: { id: "PM1", charge_date: "2026-10-19" } },
      { payment: { id: "PM1", status: "pending_submission", charge_date: "2026-10-19" } },
      {},
      null,
    ]) {
      await expect(
        provider(stub([{ status: 201, json }])).createPayment(payment(9900)),
      ).rejects.toThrow(GoCardlessApiError);
    }
    await expect(
      provider(stub([{ status: 201, text: "<html>OK</html>" }])).createPayment(payment(9900)),
    ).rejects.toThrow(/unexpected response shape/);
  });

  it("reports a gateway's HTML error page by its status alone", async () => {
    const error = await provider(stub([{ status: 502, text: "<html>Bad gateway</html>" }]))
      .createPayment(payment(9900))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoCardlessApiError);
    expect(error).toMatchObject({ status: 502, type: null, reasons: [] });
    expect((error as Error).message).toContain("HTTP 502 no message");
  });

  it("doesn't take a 409 without the original's ID as the payment already made", async () => {
    const api = stub([
      {
        status: 409,
        json: {
          error: {
            type: "invalid_api_usage",
            message: "Conflict",
            errors: [{ reason: "idempotent_creation_conflict", message: "Conflict" }],
          },
        },
      },
    ]);
    await expect(provider(api).createPayment(payment(9900))).rejects.toMatchObject({
      name: "GoCardlessApiError",
      status: 409,
    });
    expect(api.requests).toHaveLength(1);
  });

  it.each([
    ["validation_failed", 422, GoCardlessApiError],
    ["invalid_api_usage", 400, GoCardlessApiError],
    ["gocardless", 500, GoCardlessApiError],
    ["invalid_state", 422, MandateUnusableError],
  ] as const)("reports a payment refused as %s (%i) as %s", async (type, statusCode, kind) => {
    const api = stub([{ status: statusCode, json: { error: { type, message: "Refused" } } }]);
    await expect(provider(api).createPayment(payment(9900))).rejects.toBeInstanceOf(kind);
  });
});

describe("retrying and cancelling", () => {
  it("reports GoCardless refusing a retry as its error, with the reason", async () => {
    const api = stub([
      {
        status: 422,
        json: {
          error: {
            type: "invalid_state",
            message: "Payment cannot be retried",
            errors: [{ reason: "retry_failed", message: "Payment cannot be retried" }],
          },
        },
      },
    ]);
    await expect(provider(api).retryPayment("PM1")).rejects.toMatchObject({
      status: 422,
      reasons: ["retry_failed"],
    });
    expect(api.requests[0]).toMatchObject({
      method: "POST",
      url: "https://api-sandbox.gocardless.com/payments/PM1/actions/retry",
    });
  });

  it("escapes a reference in the path, so a strange one can't reach another endpoint", async () => {
    const api = stub([
      {
        status: 200,
        json: { payments: { id: "x", status: "submitted", charge_date: "2026-10-19" } },
      },
    ]);
    await provider(api).retryPayment("PM1/../../mandates/MD1");
    expect(api.requests[0]?.url).toBe(
      "https://api-sandbox.gocardless.com/payments/PM1%2F..%2F..%2Fmandates%2FMD1/actions/retry",
    );
  });

  it("only treats a refusal to cancel as done when the mandate can't be cancelled any more", async () => {
    const notFound = stub([
      { status: 404, json: { error: { type: "invalid_api_usage", message: "Not found" } } },
    ]);
    await expect(provider(notFound).cancelMandate("MD_MISSING")).rejects.toMatchObject({
      status: 404,
    });
    const down = stub([{ status: 503, text: "unavailable" }]);
    await expect(provider(down).cancelMandate("MD1")).rejects.toMatchObject({ status: 503 });
  });
});

describe("webhooks GoCardless wouldn't send", () => {
  const sign = (bytes: Buffer) => createHmac("sha256", SECRET).update(bytes).digest("hex");
  const parse = (events: unknown[], headers?: Record<string, string | string[]>) => {
    const raw = Buffer.from(JSON.stringify({ events }));
    return provider(stub([])).verifyAndParseWebhook(
      raw,
      headers ?? { "webhook-signature": sign(raw) },
    );
  };
  const event = {
    id: "EV1",
    created_at: "2026-10-15T09:00:00.000Z",
    resource_type: "payments",
    action: "failed",
    links: { payment: "PM1" },
  };

  it("refuses a signature header sent twice", () => {
    const raw = Buffer.from(JSON.stringify({ events: [event] }));
    expect(() =>
      provider(stub([])).verifyAndParseWebhook(raw, {
        "webhook-signature": [sign(raw), sign(raw)],
      }),
    ).toThrow(PaymentsWebhookError);
  });

  it("keeps the events in the order sent, each with its own references", () => {
    const events = parse([
      { ...event, id: "EV1", action: "submitted" },
      { ...event, id: "EV2", action: "confirmed" },
      { ...event, id: "EV3", action: "paid_out" },
    ]);
    expect(events.map((e) => [e.id, e.action])).toEqual([
      ["EV1", "submitted"],
      ["EV2", "confirmed"],
      ["EV3", "paid_out"],
    ]);
  });

  it("gives no cause when GoCardless gives none, and names a resource it doesn't handle 'other'", () => {
    const [first, second] = parse([
      event,
      {
        ...event,
        id: "EV2",
        resource_type: "refunds",
        action: "created",
        links: { refund: "RF1" },
      },
    ]);
    expect(first).toMatchObject({ cause: null, description: null, resourceType: "payments" });
    expect(second).toMatchObject({ resourceType: "other", links: { payment: undefined } });
  });

  it("prefers a mandate named outright to one a billing request made", () => {
    const [parsed] = parse([
      {
        ...event,
        resource_type: "billing_requests",
        action: "fulfilled",
        links: {
          billing_request: "BRQ1",
          mandate: "MD_DIRECT",
          mandate_request_mandate: "MD_MADE",
        },
      },
    ]);
    expect(parsed?.links.mandate).toBe("MD_DIRECT");
  });

  it("refuses an event whose references aren't strings", () => {
    expect(() => parse([{ ...event, links: { payment: 12345 } }])).toThrow(PaymentsWebhookError);
    expect(() => parse([{ ...event, action: null }])).toThrow(PaymentsWebhookError);
  });
});
