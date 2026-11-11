import { describe, expect, it } from "vitest";
import { FakePaymentsProvider } from "./payments.fake.ts";
import { PaymentsWebhookError } from "./payments.ts";

const setupRequest = {
  businessName: "Wren Plumbing",
  redirectUrl: "https://app.example/done",
  exitUrl: "https://app.example/exit",
  metadata: { tenantId: "t1" },
  idempotencyKey: "setup:t1",
};

describe("FakePaymentsProvider", () => {
  it("walks a set-up from pending to fulfilled, and honours idempotency keys", async () => {
    const fake = new FakePaymentsProvider();
    const setup = await fake.startMandateSetup(setupRequest);
    expect(await fake.mandateSetupState(setup.setupRef)).toEqual({
      status: "pending",
      mandateRef: null,
    });
    expect((await fake.startMandateSetup(setupRequest)).setupRef).toBe(setup.setupRef);

    const mandateRef = fake.completeSetup(setup.setupRef);
    expect(await fake.mandateSetupState(setup.setupRef)).toEqual({
      status: "fulfilled",
      mandateRef,
    });

    const payment = {
      mandateRef,
      amountPence: 9900,
      description: "x",
      metadata: {},
      idempotencyKey: "p1",
    };
    const first = await fake.createPayment(payment);
    expect(await fake.createPayment(payment)).toEqual(first);
    expect(fake.payments).toHaveLength(1);
    // Like GoCardless, the key wins: a repeat with a different amount gets the original back
    // and moves no more money.
    expect(await fake.createPayment({ ...payment, amountPence: 19_800 })).toEqual(first);
    expect(fake.payments.map((p) => p.amountPence)).toEqual([9900]);
    // A different key is a different payment.
    expect((await fake.createPayment({ ...payment, idempotencyKey: "p2" })).paymentRef).not.toBe(
      first.paymentRef,
    );
  });

  it("signs webhooks the way GoCardless does, and refuses a tampered one", () => {
    const fake = new FakePaymentsProvider();
    const event = {
      id: "EV1",
      resourceType: "payments" as const,
      action: "confirmed",
      cause: "payment_confirmed",
      description: null,
      links: { payment: "PM1" },
      createdAt: new Date("2026-11-10T12:00:00.000Z"),
    };
    const { rawBody, headers } = fake.webhookFor([event]);
    expect(fake.verifyAndParseWebhook(rawBody, headers)).toEqual([
      { ...event, links: { payment: "PM1", mandate: undefined, billingRequest: undefined } },
    ]);
    const tampered = Buffer.from(rawBody.toString("utf8").replace("PM1", "PM2"));
    expect(() => fake.verifyAndParseWebhook(tampered, headers)).toThrow(PaymentsWebhookError);
  });

  it("fails when told to", async () => {
    const fake = new FakePaymentsProvider().willFail("GoCardless down");
    await expect(fake.startMandateSetup(setupRequest)).rejects.toThrow("GoCardless down");
    await expect(fake.startMandateSetup(setupRequest)).resolves.toMatchObject({
      setupRef: expect.any(String) as string,
    });
  });
});
