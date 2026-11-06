import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { EXTRACTION_FAILED_SUMMARY } from "../core/extraction.ts";
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
      },
      costs: [
        { component: "fake-model:input_tokens", units: "100.0000" },
        { component: "fake-model:output_tokens", units: "20.0000" },
      ],
    });
    expect(llm.requests[0]?.user).toContain("Caller: It's Sam");
    expect(llm.requests[0]?.system).toContain("run by Ant");
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

  it("skips a call that's already been processed", async () => {
    const { tenantId, callId } = await makeCall();
    const llm = new FakeLlmProvider().willReturn(GOOD);
    await runProcessCall({ pool: app, llm }, { tenantId, callId, providerCallId: "x" });
    expect(
      await runProcessCall({ pool: app, llm }, { tenantId, callId, providerCallId: "x" }),
    ).toBe("already-processed");
    expect(llm.requests).toHaveLength(1);
  });

  it("has nothing to extract from a fallback voicemail", async () => {
    const { tenantId, callId } = await makeCall({ transcript: null, viaFallback: true });
    const llm = new FakeLlmProvider();
    expect(
      await runProcessCall({ pool: app, llm }, { tenantId, callId, providerCallId: "x" }),
    ).toBe("no-transcript");
    expect(llm.requests).toHaveLength(0);
  });
});
