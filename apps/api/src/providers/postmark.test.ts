import { describe, expect, it } from "vitest";
import { PostmarkApiError, PostmarkEmailProvider } from "./postmark.ts";

function stub(reply: { status: number; body: unknown }) {
  const requests: {
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }[] = [];
  const fetchStub: typeof fetch = (input, init) => {
    requests.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
        string,
        unknown
      >,
    });
    return Promise.resolve(
      typeof reply.body === "string"
        ? new Response(reply.body, { status: reply.status })
        : Response.json(reply.body, { status: reply.status }),
    );
  };
  return { fetch: fetchStub, requests };
}

const MESSAGE = {
  to: "sam@example.com",
  subject: "URGENT: Sam, 07700 900123 - Boiler leaking.",
  text: "Boiler leaking.",
  html: "<p>Boiler leaking.</p>",
};

describe("PostmarkEmailProvider", () => {
  it("posts the message with the server token and returns Postmark's message ID", async () => {
    const api = stub({
      status: 200,
      body: {
        To: "sam@example.com",
        SubmittedAt: "2026-11-08T10:00:00Z",
        MessageID: "b7bc2f4a-e38e-4336-af7d-e6c392c2f817",
        ErrorCode: 0,
        Message: "OK",
      },
    });
    const provider = new PostmarkEmailProvider({
      serverToken: "not-a-real-token",
      from: "calls@example.com",
      replyTo: "support@example.com",
      fetch: api.fetch,
    });
    expect(await provider.send(MESSAGE)).toEqual({
      providerRef: "b7bc2f4a-e38e-4336-af7d-e6c392c2f817",
    });
    expect(api.requests[0]).toMatchObject({
      url: "https://api.postmarkapp.com/email",
      headers: { "X-Postmark-Server-Token": "not-a-real-token", Accept: "application/json" },
      body: {
        From: "calls@example.com",
        To: "sam@example.com",
        Subject: MESSAGE.subject,
        TextBody: MESSAGE.text,
        HtmlBody: MESSAGE.html,
        MessageStream: "outbound",
        ReplyTo: "support@example.com",
      },
    });
  });

  it("throws with Postmark's error code when the request is rejected", async () => {
    const api = stub({ status: 422, body: { ErrorCode: 406, Message: "Inactive recipient" } });
    const provider = new PostmarkEmailProvider({
      serverToken: "not-a-real-token",
      from: "calls@example.com",
      fetch: api.fetch,
    });
    await expect(provider.send(MESSAGE)).rejects.toMatchObject({
      name: "PostmarkApiError",
      status: 422,
      errorCode: 406,
    });
    expect(api.requests[0]!.body).not.toHaveProperty("ReplyTo");
  });

  it("copes with a non-JSON failure and a 200 without a message ID", async () => {
    const gateway = new PostmarkEmailProvider({
      serverToken: "t",
      from: "calls@example.com",
      fetch: stub({ status: 502, body: "<html>Bad gateway</html>" }).fetch,
    });
    await expect(gateway.send(MESSAGE)).rejects.toBeInstanceOf(PostmarkApiError);

    const odd = new PostmarkEmailProvider({
      serverToken: "t",
      from: "calls@example.com",
      fetch: stub({ status: 200, body: { ErrorCode: 0, Message: "OK" } }).fetch,
    });
    await expect(odd.send(MESSAGE)).rejects.toThrow(/HTTP 200/);
  });

  it("gives up on a request Postmark never answers", async () => {
    const hung: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason as Error));
      });
    const provider = new PostmarkEmailProvider({
      serverToken: "t",
      from: "calls@example.com",
      fetch: hung,
      timeoutMs: 20,
    });
    await expect(provider.send(MESSAGE)).rejects.toThrow(/timed out|abort/i);
  });
});
