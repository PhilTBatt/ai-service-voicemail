import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { EMPTY_TRANSCRIPT_SUMMARY, EXTRACTION_FAILED_SUMMARY } from "../core/extraction.ts";
import { gasScript } from "../core/scripts.ts";
import { assignPhoneNumber, createAdminPool, createTenant } from "../db/cross-tenant.ts";
import { createPool } from "../db/pool.ts";
import { withTenant } from "../db/tenant.ts";
import { FakeLlmProvider } from "../providers/llm.fake.ts";
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "../testing/databases.ts";
import { runProcessCall } from "./process-call.ts";

const app = createPool(TEST_DATABASE_URL);
const admin = createAdminPool(TEST_ADMIN_DATABASE_URL);

afterAll(async () => {
  await Promise.all([app.end(), admin.end()]);
});

const TRANSCRIPT =
  "agent: Hi, you're through to Extract Plumbing. How can I help?\n" +
  "caller: It's Sam, my boiler's leaking and I can smell gas a bit. I'm on 07700 900123, postcode XQ12 3JL.";

/** A tenant with one stored, unprocessed call. */
async function makeCall(overrides: { transcript?: string | null; viaFallback?: boolean } = {}) {
  const tenantId = await createTenant(admin, {
    businessName: "Extract Plumbing",
    contactName: "Ant",
    trade: "plumber",
  });
  await assignPhoneNumber(
    admin,
    tenantId,
    `+441914980${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`,
    `PN${randomUUID()}`,
  ).catch(() => undefined);
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO calls (tenant_id, provider_call_id, caller_number, started_at, ended_at, transcript, via_fallback)
     VALUES ($1, $2, '+447700900123', now() - interval '2 minutes', now(), $3, $4) RETURNING id`,
    [
      tenantId,
      `call_${randomUUID()}`,
      overrides.transcript === undefined ? TRANSCRIPT : overrides.transcript,
      overrides.viaFallback ?? false,
    ],
  );
  return { tenantId, callId: rows[0]!.id };
}

const callRow = (tenantId: string, callId: string) =>
  withTenant(app, tenantId, async (client) => {
    const { rows } = await client.query(
      "SELECT summary, urgency, flags, extracted_fields FROM calls WHERE id = $1",
      [callId],
    );
    const costs = await client.query<{ component: string; units: string }>(
      "SELECT component, units FROM call_costs WHERE call_id = $1 ORDER BY component",
      [callId],
    );
    return { ...(rows[0] as Record<string, unknown>), costs: costs.rows };
  });

const GOOD = {
  callerName: "Sam",
  callbackNumber: "+447700900123",
  postcode: "XQ12 3JL",
  jobSummary: "Boiler leaking; caller smelt gas.",
  urgency: "emergency",
  priceAsked: false,
  flags: ["mentioned gas smell"],
};

describe("runProcessCall", () => {
  const DANGER_CALL =
    "agent: Hi, you're through to Extract Plumbing. How can I help?\n" +
    "caller: There's a burning smell coming from the fuse box.\n" +
    "agent: If anyone is in danger, or there's a fire or smoke, please hang up now and call 999.";

  it("treats a call where the agent spoke an emergency script as an emergency, whatever the summary says", async () => {
    const { tenantId, callId } = await makeCall({ transcript: DANGER_CALL });
    const queued: { urgency: string | null }[] = [];
    const llm = new FakeLlmProvider().willReturn({ ...GOOD, urgency: "urgent" });
    await runProcessCall(
      {
        pool: app,
        llm,
        enqueueNotifications: (_client, call) => {
          queued.push(call);
          return Promise.resolve();
        },
      },
      { tenantId, callId, providerCallId: "x" },
    );
    expect(await callRow(tenantId, callId)).toMatchObject({ urgency: "emergency" });
    // The emergency texts first, before the LLM is asked; then everything with the summary.
    expect(queued).toEqual([
      { tenantId, callId, urgency: "emergency", emergencyOnly: true, emergencyKind: "danger" },
      { tenantId, callId, urgency: "emergency" },
    ]);
  });

  it("queues an emergency's texts even when the LLM is down, before retrying", async () => {
    const { tenantId, callId } = await makeCall({ transcript: DANGER_CALL });
    const queued: unknown[] = [];
    await expect(
      runProcessCall(
        {
          pool: app,
          llm: new FakeLlmProvider().willThrow("overloaded", 529),
          enqueueNotifications: (_client, call) => {
            queued.push(call);
            return Promise.resolve();
          },
        },
        { tenantId, callId, providerCallId: "x" },
      ),
    ).rejects.toThrow("overloaded");
    expect(queued).toEqual([
      { tenantId, callId, urgency: "emergency", emergencyOnly: true, emergencyKind: "danger" },
    ]);
  });

  it("and when the summary fails altogether", async () => {
    const { tenantId, callId } = await makeCall({ transcript: DANGER_CALL });
    const llm = new FakeLlmProvider().willFail("invalid-output").willFail("invalid-output");
    await runProcessCall({ pool: app, llm }, { tenantId, callId, providerCallId: "x" });
    expect(await callRow(tenantId, callId)).toMatchObject({ urgency: "emergency" });
  });

  it("stores the extraction and the token costs", async () => {
    const { tenantId, callId } = await makeCall();
    const llm = new FakeLlmProvider().willReturn(GOOD);
    expect(
      await runProcessCall({ pool: app, llm }, { tenantId, callId, providerCallId: "x" }),
    ).toBe("extracted");

    expect(await callRow(tenantId, callId)).toEqual({
      summary: "Boiler leaking; caller smelt gas.",
      urgency: "emergency",
      flags: ["mentioned gas smell"],
      extracted_fields: {
        callerName: "Sam",
        callbackNumber: "+447700900123",
        postcode: "XQ12 3JL",
        priceAsked: false,
        guardrailHits: [],
      },
      costs: [
        { component: "fake-model:input_tokens", units: "100.0000" },
        { component: "fake-model:output_tokens", units: "20.0000" },
      ],
    });
    expect(llm.requests[0]?.user).toContain("Caller: It's Sam");
    expect(llm.requests[0]?.system).toContain("run by Ant");
  });

  it("flags the call for review and alerts when the agent quoted a price or committed to a time", async () => {
    const { tenantId, callId } = await makeCall({
      transcript: [
        "agent: It'll cost about £90 and Ant will be there tomorrow at 9.",
        "caller: Great.",
      ].join("\n"),
    });
    const llm = new FakeLlmProvider().willReturn(GOOD);
    const alert = vi.fn();
    await runProcessCall({ pool: app, llm, alert }, { tenantId, callId, providerCallId: "x" });
    expect(await callRow(tenantId, callId)).toMatchObject({
      flags: ["mentioned gas smell", "guardrail:price", "guardrail:commitment"],
      extracted_fields: expect.objectContaining({
        guardrailHits: [
          { rule: "price", excerpt: "It'll cost about £90 and Ant will be there tomorrow at 9." },
          {
            rule: "commitment",
            excerpt: "It'll cost about £90 and Ant will be there tomorrow at 9.",
          },
        ],
      }) as unknown,
    });
    expect(alert).toHaveBeenCalledWith("guardrail-hit", {
      tenantId,
      callId,
      rules: ["guardrail:price", "guardrail:commitment"],
    });
  });

  it("flags safety advice in the agent's own words, but not the scripts it spoke", async () => {
    const { tenantId, callId } = await makeCall({
      transcript: [
        `agent: ${gasScript("Ant", "GB")}`,
        "caller: Should I unplug the boiler?",
        "agent: Yes, unplug it and keep the windows open.",
      ].join("\n"),
    });
    const llm = new FakeLlmProvider().willReturn(GOOD);
    const alert = vi.fn();
    await runProcessCall({ pool: app, llm, alert }, { tenantId, callId, providerCallId: "x" });
    expect(await callRow(tenantId, callId)).toMatchObject({
      flags: ["mentioned gas smell", "guardrail:safety"],
      extracted_fields: expect.objectContaining({
        guardrailHits: [{ rule: "safety", excerpt: "Yes, unplug it and keep the windows open." }],
      }) as unknown,
    });
    expect(alert).toHaveBeenCalledWith("guardrail-hit", {
      tenantId,
      callId,
      rules: ["guardrail:safety"],
    });
  });

  it("retries invalid output once, then stores the fallback summary and alerts", async () => {
    const { tenantId, callId } = await makeCall();
    const llm = new FakeLlmProvider().willReturn({ urgency: "panic" }).willFail("invalid-output");
    const alert = vi.fn();
    expect(
      await runProcessCall({ pool: app, llm, alert }, { tenantId, callId, providerCallId: "x" }),
    ).toBe("extraction-failed");
    expect(llm.requests).toHaveLength(2);
    expect(await callRow(tenantId, callId)).toMatchObject({
      summary: EXTRACTION_FAILED_SUMMARY,
      urgency: null,
      flags: ["extraction_failed"],
      costs: [
        { component: "fake-model:input_tokens", units: "200.0000" },
        { component: "fake-model:output_tokens", units: "40.0000" },
      ],
    });
    expect(alert).toHaveBeenCalledWith(
      "call-extraction-failed",
      expect.objectContaining({ callId }),
    );
  });

  it("doesn't retry a refusal", async () => {
    const { tenantId, callId } = await makeCall();
    const llm = new FakeLlmProvider().willFail("refused");
    expect(
      await runProcessCall(
        { pool: app, llm, alert: vi.fn() },
        { tenantId, callId, providerCallId: "x" },
      ),
    ).toBe("extraction-failed");
    expect(llm.requests).toHaveLength(1);
  });

  it("lets an API error propagate so the queue retries, storing nothing", async () => {
    const { tenantId, callId } = await makeCall();
    const llm = new FakeLlmProvider().willThrow("rate limited");
    await expect(
      runProcessCall({ pool: app, llm }, { tenantId, callId, providerCallId: "x" }),
    ).rejects.toThrow("rate limited");
    expect(await callRow(tenantId, callId)).toMatchObject({ summary: null, costs: [] });
  });

  // An outage used to leave these calls with no text at all once the retries ran out.
  it("sends the texts without a summary once the LLM has failed for three minutes after the call", async () => {
    const { tenantId, callId } = await makeCall();
    const enqueueNotifications = vi.fn(() => Promise.resolve());
    const alert = vi.fn();
    const later = () => new Date(Date.now() + 4 * 60_000);
    expect(
      await runProcessCall(
        {
          pool: app,
          llm: new FakeLlmProvider().willThrow("overloaded", 529),
          alert,
          enqueueNotifications,
          now: later,
        },
        { tenantId, callId, providerCallId: "x" },
      ),
    ).toBe("extraction-failed");
    expect(await callRow(tenantId, callId)).toMatchObject({ summary: EXTRACTION_FAILED_SUMMARY });
    expect(enqueueNotifications).toHaveBeenCalledWith(expect.anything(), {
      tenantId,
      callId,
      urgency: null,
    });
    expect(alert).toHaveBeenCalledWith("call-extraction-failed", { tenantId, callId });
  });

  it("doesn't wait at all on an error retrying can't fix, such as a revoked key", async () => {
    const { tenantId, callId } = await makeCall();
    const enqueueNotifications = vi.fn(() => Promise.resolve());
    expect(
      await runProcessCall(
        {
          pool: app,
          llm: new FakeLlmProvider().willThrow("invalid x-api-key", 401),
          alert: vi.fn(),
          enqueueNotifications,
        },
        { tenantId, callId, providerCallId: "x" },
      ),
    ).toBe("extraction-failed");
    expect(enqueueNotifications).toHaveBeenCalledTimes(1);
  });

  it("stores the call-back number as a number, or none when it isn't one, so the caller ID is used", async () => {
    for (const [given, stored] of [
      ["+44 7700 900123", "+447700900123"],
      ["", null],
      ["oh seven seven double oh", null],
    ] as const) {
      const { tenantId, callId } = await makeCall();
      await runProcessCall(
        { pool: app, llm: new FakeLlmProvider().willReturn({ ...GOOD, callbackNumber: given }) },
        { tenantId, callId, providerCallId: "x" },
      );
      expect(await callRow(tenantId, callId), given).toMatchObject({
        extracted_fields: expect.objectContaining({ callbackNumber: stored }) as unknown,
      });
    }
  });

  it("marks a call where the water script was spoken at least urgent, as the caller was told", async () => {
    const { tenantId, callId } = await makeCall({
      transcript:
        "agent: Hi, you're through to Extract Plumbing. How can I help?\n" +
        "caller: There's water coming through the ceiling.\n" +
        "agent: If it's safe to, turn off your water at the stopcock. I'm marking this as urgent for Ant now.\n" +
        "caller: It's stopped now actually.",
    });
    await runProcessCall(
      {
        pool: app,
        llm: new FakeLlmProvider().willReturn({ ...GOOD, urgency: "routine" }),
      },
      { tenantId, callId, providerCallId: "x" },
    );
    expect(await callRow(tenantId, callId)).toMatchObject({ urgency: "urgent" });
  });

  it("queues the notifications through the same transaction, even when extraction failed", async () => {
    const { tenantId, callId } = await makeCall();
    const enqueueNotifications = vi.fn(async (client: pg.ClientBase) => {
      // Inside the transaction: the summary is already visible to this client.
      const { rows } = await client.query<{ summary: string }>(
        "SELECT summary FROM calls WHERE id = $1",
        [callId],
      );
      expect(rows[0]?.summary).toBe(EXTRACTION_FAILED_SUMMARY);
    });
    const llm = new FakeLlmProvider().willFail("refused");
    await runProcessCall(
      { pool: app, llm, alert: vi.fn(), enqueueNotifications },
      { tenantId, callId, providerCallId: "x" },
    );
    expect(enqueueNotifications).toHaveBeenCalledWith(expect.anything(), {
      tenantId,
      callId,
      urgency: null,
    });

    // Not again for a call that's already processed.
    await runProcessCall(
      { pool: app, llm, enqueueNotifications },
      { tenantId, callId, providerCallId: "x" },
    );
    expect(enqueueNotifications).toHaveBeenCalledTimes(1);
  });

  it("passes the urgency on, so emergencies get their own texts", async () => {
    const { tenantId, callId } = await makeCall();
    const enqueueNotifications = vi.fn(() => Promise.resolve());
    await runProcessCall(
      { pool: app, llm: new FakeLlmProvider().willReturn(GOOD), enqueueNotifications },
      { tenantId, callId, providerCallId: "x" },
    );
    expect(enqueueNotifications).toHaveBeenCalledWith(expect.anything(), {
      tenantId,
      callId,
      urgency: "emergency",
    });
  });

  it("skips a call that's already been processed", async () => {
    const { tenantId, callId } = await makeCall();
    const llm = new FakeLlmProvider().willReturn(GOOD);
    await runProcessCall({ pool: app, llm }, { tenantId, callId, providerCallId: "x" });
    expect(
      await runProcessCall({ pool: app, llm }, { tenantId, callId, providerCallId: "x" }),
    ).toBe("already-processed");
    expect(llm.requests).toHaveLength(1);
  });

  it("has nothing to extract from a fallback voicemail that hasn't been transcribed", async () => {
    const { tenantId, callId } = await makeCall({ transcript: null, viaFallback: true });
    const llm = new FakeLlmProvider();
    expect(
      await runProcessCall({ pool: app, llm }, { tenantId, callId, providerCallId: "x" }),
    ).toBe("no-transcript");
    expect(llm.requests).toHaveLength(0);
  });

  // Voicemail transcription (decision 022): the words come back as one caller turn, and the
  // voicemail then gets a summary, an urgency and its messages like a call.
  it("summarises a transcribed voicemail with the voicemail prompt, keeping the recording's length", async () => {
    const { tenantId, callId } = await makeCall({
      transcript: "caller: It's Sam, I can smell gas by the boiler. 07700 900123, XQ12 3JL.",
      viaFallback: true,
    });
    await admin.query(
      `UPDATE calls SET extracted_fields = '{"recordingSeconds": 42}', outcome = 'voicemail' WHERE id = $1`,
      [callId],
    );
    const queued: { urgency: string | null }[] = [];
    const llm = new FakeLlmProvider().willReturn(GOOD);
    expect(
      await runProcessCall(
        {
          pool: app,
          llm,
          enqueueNotifications: (_client, call) => {
            queued.push(call);
            return Promise.resolve();
          },
        },
        { tenantId, callId, providerCallId: "x" },
      ),
    ).toBe("extracted");
    expect(llm.requests[0]?.system).toContain(
      "transcripts of voicemails left for Extract Plumbing",
    );
    expect(llm.requests[0]?.user).toBe(
      "Voicemail transcript:\n\nCaller: It's Sam, I can smell gas by the boiler. 07700 900123, XQ12 3JL.",
    );
    expect(await callRow(tenantId, callId)).toMatchObject({
      summary: GOOD.jobSummary,
      urgency: "emergency",
      extracted_fields: expect.objectContaining({
        recordingSeconds: 42,
        callerName: "Sam",
      }) as unknown,
    });
    // No agent spoke a script, so no early emergency texts: the one enqueue carries the verdict.
    expect(queued).toEqual([{ tenantId, callId, urgency: "emergency" }]);
  });

  // An agent call with no words in it (the caller rang off at once, or the platform sent no
  // transcript) used to stop here with no text or email at all.
  it.each([
    ["an empty transcript", ""],
    ["turns with no words in them", "agent: \ncaller:  "],
  ])(
    "still sends the text and email for %s, without asking the LLM, once",
    async (_what, transcript) => {
      const { tenantId, callId } = await makeCall({ transcript });
      const llm = new FakeLlmProvider();
      const enqueueNotifications = vi.fn(() => Promise.resolve());
      expect(
        await runProcessCall(
          { pool: app, llm, enqueueNotifications },
          { tenantId, callId, providerCallId: "x" },
        ),
      ).toBe("empty-transcript");
      expect(llm.requests).toHaveLength(0);
      expect(await callRow(tenantId, callId)).toMatchObject({
        summary: EMPTY_TRANSCRIPT_SUMMARY,
        urgency: null,
        flags: [],
        costs: [], // no LLM, so no tokens
      });
      expect(enqueueNotifications).toHaveBeenCalledWith(expect.anything(), {
        tenantId,
        callId,
        urgency: null,
      });

      // Redelivered: nothing more.
      expect(
        await runProcessCall(
          { pool: app, llm, enqueueNotifications },
          { tenantId, callId, providerCallId: "x" },
        ),
      ).toBe("already-processed");
      expect(enqueueNotifications).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps a mid-call emergency with an empty transcript an emergency", async () => {
    const { tenantId, callId } = await makeCall({ transcript: "" });
    await admin.query(
      "UPDATE calls SET urgency = 'emergency', flags = ARRAY['emergency:gas'] WHERE id = $1",
      [callId],
    );
    const enqueueNotifications = vi.fn(() => Promise.resolve());
    await runProcessCall(
      { pool: app, llm: new FakeLlmProvider(), enqueueNotifications },
      { tenantId, callId, providerCallId: "x" },
    );
    expect(await callRow(tenantId, callId)).toMatchObject({
      summary: EMPTY_TRANSCRIPT_SUMMARY,
      urgency: "emergency",
      flags: ["emergency:gas"],
    });
    expect(enqueueNotifications).toHaveBeenCalledWith(expect.anything(), {
      tenantId,
      callId,
      urgency: "emergency",
    });
  });
});

describe("runProcessCall after a mid-call emergency", () => {
  it("keeps the call an emergency even if the extraction says otherwise", async () => {
    const { tenantId, callId } = await makeCall();
    await admin.query(
      "UPDATE calls SET urgency = 'emergency', flags = ARRAY['emergency:gas'] WHERE id = $1",
      [callId],
    );
    const enqueueNotifications = vi.fn(() => Promise.resolve());
    await runProcessCall(
      {
        pool: app,
        llm: new FakeLlmProvider().willReturn({ ...GOOD, urgency: "urgent" }),
        enqueueNotifications,
      },
      { tenantId, callId, providerCallId: "x" },
    );
    expect(await callRow(tenantId, callId)).toMatchObject({
      urgency: "emergency",
      flags: ["emergency:gas", "mentioned gas smell"],
    });
    expect(enqueueNotifications).toHaveBeenCalledWith(expect.anything(), {
      tenantId,
      callId,
      urgency: "emergency",
    });
  });
});

describe("runProcessCall with the judge sampled in", () => {
  it("flags and alerts a summary the judge rejects, storing the reason only in the row", async () => {
    const { tenantId, callId } = await makeCall();
    const llm = new FakeLlmProvider()
      .willReturn(GOOD)
      .willReturn({ pass: false, reason: "The summary invents a boiler fault." });
    const alert = vi.fn();
    await runProcessCall(
      { pool: app, llm, alert, judgeSampleRate: 0.5, random: () => 0.2 },
      { tenantId, callId, providerCallId: "x" },
    );
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]?.system).toContain("hallucination");
    expect(await callRow(tenantId, callId)).toMatchObject({
      flags: ["mentioned gas smell", "judge:failed"],
      extracted_fields: expect.objectContaining({
        judge: { pass: false, reason: "The summary invents a boiler fault." },
      }) as unknown,
      costs: [
        { component: "fake-model:input_tokens", units: "200.0000" },
        { component: "fake-model:output_tokens", units: "40.0000" },
      ],
    });
    expect(alert).toHaveBeenCalledWith("summary-judge-failed", { tenantId, callId });
  });

  it("skips the check when it can't run, and still sends the texts", async () => {
    const { tenantId, callId } = await makeCall();
    const enqueueNotifications = vi.fn(() => Promise.resolve());
    expect(
      await runProcessCall(
        {
          pool: app,
          llm: new FakeLlmProvider().willReturn(GOOD).willThrow("overloaded", 529),
          enqueueNotifications,
          judgeSampleRate: 1,
          random: () => 0,
        },
        { tenantId, callId, providerCallId: "x" },
      ),
    ).toBe("extracted");
    expect(await callRow(tenantId, callId)).toMatchObject({ summary: GOOD.jobSummary });
    expect(enqueueNotifications).toHaveBeenCalledTimes(1);
  });

  it("leaves the call alone when the sample misses, and never judges by default", async () => {
    const { tenantId, callId } = await makeCall();
    const llm = new FakeLlmProvider().willReturn(GOOD);
    await runProcessCall(
      { pool: app, llm, judgeSampleRate: 0.5, random: () => 0.9 },
      { tenantId, callId, providerCallId: "x" },
    );
    expect(llm.requests).toHaveLength(1);
    const { tenantId: t2, callId: c2 } = await makeCall();
    const llm2 = new FakeLlmProvider().willReturn(GOOD);
    await runProcessCall(
      { pool: app, llm: llm2, random: () => 0 },
      { tenantId: t2, callId: c2, providerCallId: "y" },
    );
    expect(llm2.requests).toHaveLength(1);
  });
});

describe("runProcessCall and the caller ID", () => {
  it("tells the extraction which number the caller rang from", async () => {
    const { tenantId, callId } = await makeCall();
    const llm = new FakeLlmProvider().willReturn(GOOD);
    await runProcessCall({ pool: app, llm }, { tenantId, callId, providerCallId: "x" });
    expect(llm.requests[0]?.system).toContain("The caller rang from +447700900123");
  });
});
