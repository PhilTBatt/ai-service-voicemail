import { describe, expect, it } from "vitest";
import { TwilioSmsProvider } from "./twilio-sms.ts";

const ACCOUNT_SID = "AC" + "0".repeat(32);

function stub(status = 201) {
  const requests: { url: string; form: Record<string, string>; auth: string | undefined }[] = [];
  const fetchStub: typeof fetch = (input, init) => {
    requests.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      form: Object.fromEntries(
        new URLSearchParams(typeof init?.body === "string" ? init.body : ""),
      ),
      auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
    });
    return Promise.resolve(
      status === 201
        ? Response.json(
            { sid: "SM" + "1".repeat(32), num_segments: "2", status: "queued" },
            { status },
          )
        : Response.json({ code: 21211, message: "Invalid 'To' Phone Number" }, { status }),
    );
  };
  return { fetch: fetchStub, requests };
}

describe("TwilioSmsProvider", () => {
  it("posts the message from the notification number and returns the SID and segment count", async () => {
    const api = stub();
    const provider = new TwilioSmsProvider({
      accountSid: ACCOUNT_SID,
      authToken: "not-a-real-token",
      from: "+447700900900",
      fetch: api.fetch,
    });
    const receipt = await provider.send({ to: "+447700900001", body: "Hello" });
    expect(receipt).toEqual({ providerRef: "SM" + "1".repeat(32), segments: 2 });
    expect(api.requests[0]).toMatchObject({
      url: `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`,
      form: { To: "+447700900001", From: "+447700900900", Body: "Hello" },
      auth: `Basic ${Buffer.from(`${ACCOUNT_SID}:not-a-real-token`).toString("base64")}`,
    });
  });

  it("leaves the segment count to us when Twilio gives none, or 0", async () => {
    for (const numSegments of [null, "0", undefined]) {
      const answered: typeof fetch = () =>
        Promise.resolve(
          Response.json({ sid: "SM" + "2".repeat(32), num_segments: numSegments }, { status: 201 }),
        );
      const provider = new TwilioSmsProvider({
        accountSid: ACCOUNT_SID,
        authToken: "not-a-real-token",
        from: "AnswerMate",
        fetch: answered,
      });
      expect(await provider.send({ to: "+447700900001", body: "Hello" })).toEqual({
        providerRef: "SM" + "2".repeat(32),
        segments: null,
      });
    }
  });

  it("throws when Twilio's answer to a sent text has no message ID", async () => {
    const answered: typeof fetch = () =>
      Promise.resolve(Response.json({ status: "queued" }, { status: 201 }));
    const provider = new TwilioSmsProvider({
      accountSid: ACCOUNT_SID,
      authToken: "not-a-real-token",
      from: "AnswerMate",
      fetch: answered,
    });
    await expect(provider.send({ to: "+447700900001", body: "Hello" })).rejects.toThrow(
      "Twilio's answer to a sent text had no message ID",
    );
  });

  it("throws a TwilioApiError with the status when Twilio rejects the message", async () => {
    const api = stub(400);
    const provider = new TwilioSmsProvider({
      accountSid: ACCOUNT_SID,
      authToken: "not-a-real-token",
      from: "AnswerMate",
      fetch: api.fetch,
    });
    await expect(provider.send({ to: "+44", body: "x" })).rejects.toMatchObject({
      name: "TwilioApiError",
      status: 400,
    });
  });
});

describe("TwilioSmsProvider timeouts", () => {
  it("gives up on a request Twilio never answers, well inside the job expiry", async () => {
    const hung: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason as Error));
      });
    const provider = new TwilioSmsProvider({
      accountSid: ACCOUNT_SID,
      authToken: "not-a-real-token",
      from: "AnswerMate",
      fetch: hung,
      timeoutMs: 20,
    });
    await expect(provider.send({ to: "+447700900001", body: "x" })).rejects.toThrow(
      /timed out|abort/i,
    );
  });
});

describe("TwilioSmsProvider receipts", () => {
  it("asks Twilio to post delivery receipts when a callback URL is configured", async () => {
    const api = stub();
    const provider = new TwilioSmsProvider({
      accountSid: ACCOUNT_SID,
      authToken: "not-a-real-token",
      from: "AnswerMate",
      fetch: api.fetch,
      statusCallbackUrl: "https://callmate.example.com/webhooks/twilio/sms-status",
    });
    await provider.send({ to: "+447700900001", body: "Hello" });
    expect(api.requests[0]!.form).toMatchObject({
      StatusCallback: "https://callmate.example.com/webhooks/twilio/sms-status",
    });
  });
});

describe("TwilioSmsProvider.deleteMessage", () => {
  function provider(status: number) {
    const requests: { url: string; method: string | undefined }[] = [];
    const fetchStub: typeof fetch = (input, init) => {
      requests.push({
        url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        method: init?.method,
      });
      return Promise.resolve(
        status === 204
          ? new Response(null, { status })
          : Response.json(
              { code: 20404, message: "The requested resource was not found" },
              { status },
            ),
      );
    };
    const sms = new TwilioSmsProvider({
      accountSid: ACCOUNT_SID,
      authToken: "not-a-real-token",
      from: "+447700900001",
      fetch: fetchStub,
    });
    return { sms, requests };
  }

  it("deletes the message by its SID", async () => {
    const { sms, requests } = provider(204);
    await sms.deleteMessage("SM" + "2".repeat(32));
    expect(requests).toEqual([
      {
        method: "DELETE",
        url: `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages/SM${"2".repeat(32)}.json`,
      },
    ]);
  });

  it("counts a message that's already gone as deleted", async () => {
    await expect(provider(404).sms.deleteMessage("SMgone")).resolves.toBeUndefined();
  });

  it("throws when Twilio refuses for any other reason", async () => {
    await expect(provider(500).sms.deleteMessage("SMx")).rejects.toMatchObject({
      name: "TwilioApiError",
      status: 500,
    });
  });
});
