import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createPool } from "../db/pool.ts";
import { FakeVoiceProvider } from "../providers/voice.fake.ts";
import type { CallEndedEvent, WebhookHeaders } from "../providers/voice.ts";
import { sampleCallEndedEvent } from "../testing/agent-fixture.ts";

// The route never touches the database; nothing listens on port 1, so no connection is made.
const UNUSED_DATABASE_URL = "postgres://callmate_app@127.0.0.1:1/callmate";

const running: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((stop) => stop()));
});

async function startApp(onCallEnded?: (event: CallEndedEvent) => Promise<void>) {
  const fake = new FakeVoiceProvider();
  const received: CallEndedEvent[] = [];
  const pool = createPool(UNUSED_DATABASE_URL);
  const server = createApp({
    pool,
    voiceProviders: { fake },
    onCallEnded:
      onCallEnded ??
      ((event) => {
        received.push(event);
        return Promise.resolve();
      }),
  }).listen(0);
  await once(server, "listening");
  running.push(async () => {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  });
  const { port } = server.address() as AddressInfo;
  const post = (path: string, rawBody: Buffer, headers: WebhookHeaders) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: headers as Record<string, string>,
      body: new Uint8Array(rawBody), // the same bytes; Buffer's type isn't a valid BodyInit
    });
  return { fake, received, post };
}

describe("POST /webhooks/voice/:provider", () => {
  it("accepts a correctly signed call-ended webhook and hands the event on", async () => {
    const { fake, received, post } = await startApp();
    const event = sampleCallEndedEvent();
    const { rawBody, headers } = fake.webhookFor(event);

    const response = await post("/webhooks/voice/fake", rawBody, headers);
    expect(response.status).toBe(204);
    expect(received).toEqual([event]);
  });

  it("verifies the bytes as sent, not a re-serialised copy", async () => {
    // Pretty-printed JSON with a different key order: a parse-then-stringify would change it.
    const { fake, received, post } = await startApp();
    const event = sampleCallEndedEvent();
    const pretty = Buffer.from(JSON.stringify({ call: event, event: "call_ended" }, null, 2));
    const { headers } = fake.signedRequest(pretty);

    expect((await post("/webhooks/voice/fake", pretty, headers)).status).toBe(204);
    expect(received).toHaveLength(1);
  });

  it("rejects a body changed after signing with 401 and no detail", async () => {
    const { fake, received, post } = await startApp();
    const { rawBody, headers } = fake.webhookFor(sampleCallEndedEvent());
    const tampered = Buffer.from(
      rawBody.toString("utf8").replace("+447700900123", "+447700900999"),
    );

    const response = await post("/webhooks/voice/fake", tampered, headers);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(received).toEqual([]);
  });

  it("rejects a missing signature", async () => {
    const { fake, received, post } = await startApp();
    const { rawBody } = fake.webhookFor(sampleCallEndedEvent());

    const response = await post("/webhooks/voice/fake", rawBody, {
      "content-type": "application/json",
    });
    expect(response.status).toBe(401);
    expect(received).toEqual([]);
  });

  it("acknowledges a genuine webhook for an event we don't act on", async () => {
    const { fake, received, post } = await startApp();
    const { rawBody, headers } = fake.webhookFor({ event: "call_started" });

    expect((await post("/webhooks/voice/fake", rawBody, headers)).status).toBe(204);
    expect(received).toEqual([]);
  });

  it("returns 404 for a provider that isn't configured", async () => {
    const { fake, post } = await startApp();
    const { rawBody, headers } = fake.webhookFor(sampleCallEndedEvent());

    expect((await post("/webhooks/voice/nobody", rawBody, headers)).status).toBe(404);
  });

  it("answers 500 without details if handling the event fails", async () => {
    const { fake, post } = await startApp(() => Promise.reject(new Error("database down")));
    const { rawBody, headers } = fake.webhookFor(sampleCallEndedEvent());

    const response = await post("/webhooks/voice/fake", rawBody, headers);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("database down");
  });
});
