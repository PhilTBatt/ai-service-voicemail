import { afterAll, describe, expect, it, vi } from "vitest";
import { setAlertSink } from "../alerts.ts";
import { sampleAgentDefinition, sampleCallEndedEvent } from "../testing/agent-fixture.ts";
import { RetellApiStub } from "../testing/retell-stub.ts";
import {
  COOL_DOWN_ONCE_PER_CALL,
  RetellVoiceProvider,
  buildAgent,
  buildConversationFlow,
  signRetellWebhook,
} from "./retell.ts";
import { describeVoiceProviderContract, type VoiceProviderHarness } from "./voice.contract.ts";
import { WebhookVerificationError, type CallEndedEvent } from "./voice.ts";

const TEST_API_KEY = "not-a-real-key";
const NOW = new Date("2026-11-06T12:00:00Z");

/** A Retell call_ended payload carrying the same facts as a normalised event. */
function retellPayload(event: CallEndedEvent, overrides: Record<string, unknown> = {}) {
  return {
    event: "call_ended",
    call: {
      call_type: "phone_call",
      call_id: event.providerCallId,
      agent_id: event.providerAgentId,
      from_number: event.callerNumber ?? undefined,
      to_number: event.dialledNumber,
      direction: "inbound",
      start_timestamp: event.startedAt.getTime(),
      end_timestamp: event.endedAt.getTime(),
      duration_ms: event.durationSeconds * 1000,
      disconnection_reason: event.endReason,
      transcript_object: event.transcript.map((turn) => ({
        role: turn.role === "caller" ? "user" : "agent",
        content: turn.text,
      })),
      recording_url: event.recordingRef ?? undefined,
      call_cost: {
        product_costs: [{ product: "voice_minutes", unit_price: 5.5, cost: 8.25 }],
        total_duration_seconds: event.durationSeconds,
      },
      ...overrides,
    },
  };
}

function signed(body: unknown, { apiKey = TEST_API_KEY, at = NOW.getTime() } = {}) {
  const rawBody = Buffer.from(JSON.stringify(body));
  return {
    rawBody,
    headers: {
      "content-type": "application/json",
      "x-retell-signature": signRetellWebhook(rawBody, apiKey, at),
    },
  };
}

function makeStubHarness(): VoiceProviderHarness & { stub: RetellApiStub } {
  const stub = new RetellApiStub();
  const provider = new RetellVoiceProvider({
    apiKey: TEST_API_KEY,
    fetch: stub.fetch,
    now: () => NOW,
  });
  return {
    stub,
    provider,
    signedWebhook: (event) =>
      signed(
        retellPayload(event, {
          call_cost: {
            product_costs: event.costs
              .filter((c) => c.unitType === "usd_cents")
              .map((c) => ({ product: c.component.replace("retell:", ""), cost: c.units })),
            total_duration_seconds: event.costs.find((c) => c.component === "retell:duration")
              ?.units,
          },
        }),
      ),
    ignorableWebhook: () =>
      signed({ event: "call_started", call: retellPayload(sampleCallEndedEvent()).call }),
    signedFunctionCall: (event) =>
      signed({
        name: event.name,
        call: {
          call_type: "phone_call",
          call_id: event.providerCallId,
          agent_id: event.providerAgentId,
          from_number: event.callerNumber ?? undefined,
          to_number: event.dialledNumber ?? undefined,
          call_status: "ongoing",
        },
        args: {},
      }),
    seedEndedCall: (event) => {
      const { call } = retellPayload(event);
      stub.listedCalls.push({
        call_id: event.providerCallId,
        start_timestamp: call.start_timestamp,
      });
      stub.callRecords.set(event.providerCallId, call);
    },
    seedRecording: (callId, bytes) => {
      const url = `https://retell-recordings.example/${callId}/recording.wav`;
      stub.callRecords.set(callId, { call_id: callId, recording_url: url });
      stub.recordingAudio.set(url, bytes);
    },
  };
}

const retellShapedEvent = () =>
  sampleCallEndedEvent({
    costs: [
      { component: "retell:voice_minutes", units: 8.25, unitType: "usd_cents" },
      { component: "retell:duration", units: 90, unitType: "seconds" },
    ],
  });

describeVoiceProviderContract("Retell (stubbed API)", makeStubHarness);

describe("RetellVoiceProvider webhooks", () => {
  const provider = () => new RetellVoiceProvider({ apiKey: TEST_API_KEY, now: () => NOW });

  it("maps a call_ended payload: roles, costs, times and the withheld-number case", () => {
    const event = retellShapedEvent();
    const { rawBody, headers } = signed(retellPayload(event));
    expect(provider().verifyAndParseWebhook(rawBody, headers)).toEqual(event);

    const withheld = signed(retellPayload(event, { from_number: undefined }));
    expect(provider().verifyAndParseWebhook(withheld.rawBody, withheld.headers)).toMatchObject({
      callerNumber: null,
    });
  });

  // A withheld caller's number can come as a placeholder, which the database's phone type
  // would refuse, losing the call; and Retell may send null for any field it hasn't got.
  it("reads a withheld caller's placeholder as no number, and takes nulls for missing fields", () => {
    const event = retellShapedEvent();
    for (const from_number of ["anonymous", "", null]) {
      const { rawBody, headers } = signed(
        retellPayload(event, {
          from_number,
          recording_url: null,
          disconnection_reason: null,
          duration_ms: null,
          transcript_object: [{ role: "agent", content: null }],
        }),
      );
      expect(provider().verifyAndParseWebhook(rawBody, headers), String(from_number)).toMatchObject(
        {
          type: "call_ended",
          callerNumber: null,
          recordingRef: null,
          endReason: "unknown",
          transcript: [{ role: "agent", text: "" }],
        },
      );
    }
  });

  it("ignores a call that never connected, which has no start time", () => {
    const { rawBody, headers } = signed(
      retellPayload(retellShapedEvent(), { start_timestamp: undefined }),
    );
    expect(provider().verifyAndParseWebhook(rawBody, headers)).toEqual({
      type: "ignored",
      reason: "call never started",
    });
  });

  // Signed by Retell, so not a forgery: a 401 would count towards the signature alert.
  it("ignores a correctly signed body in a shape it doesn't read, and alerts if it was a call", () => {
    const sink = vi.fn(() => Promise.resolve());
    setAlertSink(sink);
    try {
      const { rawBody, headers } = signed({ event: "call_ended", call: { call_id: 42 } });
      expect(provider().verifyAndParseWebhook(rawBody, headers)).toEqual({
        type: "ignored",
        reason: "unexpected shape",
      });
      // A call we can't read is a call we'd lose: said loudly.
      expect(sink).toHaveBeenCalledWith(
        "voice-webhook-unreadable",
        expect.objectContaining({ source: "webhook" }),
      );
      // Another event in a shape we don't know is nothing to worry about.
      sink.mockClear();
      const other = signed({ event: "transcript_updated", call: { call_id: 42 } });
      expect(provider().verifyAndParseWebhook(other.rawBody, other.headers)).toMatchObject({
        type: "ignored",
      });
      expect(sink).not.toHaveBeenCalled();
    } finally {
      setAlertSink(undefined);
    }
  });

  it("keeps only speech from the transcript, not tool calls or node transitions", () => {
    const { rawBody, headers } = signed(
      retellPayload(retellShapedEvent(), {
        transcript_object: [
          { role: "node_transition", former_node_id: "begin", new_node_id: "opening" },
          { role: "agent", content: "Hi there." },
          { role: "tool_call_invocation", name: "x" },
          { role: "user", content: "Hello." },
        ],
      }),
    );
    expect(provider().verifyAndParseWebhook(rawBody, headers)).toMatchObject({
      transcript: [
        { role: "agent", text: "Hi there." },
        { role: "caller", text: "Hello." },
      ],
    });
  });

  it("ignores a web call, which has no dialled number", () => {
    const { rawBody, headers } = signed(
      retellPayload(retellShapedEvent(), {
        call_type: "web_call",
        to_number: undefined,
        from_number: undefined,
      }),
    );
    expect(provider().verifyAndParseWebhook(rawBody, headers)).toEqual({
      type: "ignored",
      reason: "no dialled number (not a phone call)",
    });
  });

  it.each([
    ["six minutes old", NOW.getTime() - 6 * 60_000],
    ["six minutes in the future", NOW.getTime() + 6 * 60_000],
  ])("rejects a signature that is %s (replay protection)", (_label, at) => {
    const { rawBody, headers } = signed(retellPayload(retellShapedEvent()), { at });
    expect(() => provider().verifyAndParseWebhook(rawBody, headers)).toThrow(/Stale/);
  });

  it("accepts a signature four minutes old", () => {
    const { rawBody, headers } = signed(retellPayload(retellShapedEvent()), {
      at: NOW.getTime() - 4 * 60_000,
    });
    expect(provider().verifyAndParseWebhook(rawBody, headers)).toMatchObject({
      type: "call_ended",
    });
  });

  it("rejects a signature made with a different key", () => {
    const { rawBody, headers } = signed(retellPayload(retellShapedEvent()), {
      apiKey: "some-other-key",
    });
    expect(() => provider().verifyAndParseWebhook(rawBody, headers)).toThrow(
      WebhookVerificationError,
    );
  });

  it.each([undefined, "", "nonsense", "v=abc,d=00", "d=00,v=123"])(
    "rejects a missing or malformed signature header (%s)",
    (header) => {
      const { rawBody } = signed(retellPayload(retellShapedEvent()));
      expect(() =>
        provider().verifyAndParseWebhook(rawBody, { "x-retell-signature": header }),
      ).toThrow(WebhookVerificationError);
    },
  );
});

describe("RetellVoiceProvider.agentFingerprint", () => {
  // What the sync job compares to decide whether a release changed an agent (jobs/sync-agent.ts).
  const at = (webhookUrl: string) =>
    new RetellVoiceProvider({
      apiKey: TEST_API_KEY,
      webhookUrl: `${webhookUrl}/webhooks/retell`,
      functionUrl: `${webhookUrl}/webhooks/retell/function`,
    });

  it("is the same for the same definition and settings, and changes with what would be sent", () => {
    const definition = sampleAgentDefinition();
    const provider = at("https://callmate.example.com");
    expect(provider.agentFingerprint(definition)).toBe(
      at("https://callmate.example.com").agentFingerprint(sampleAgentDefinition()),
    );
    // A prompt change in a release.
    expect(
      provider.agentFingerprint({
        ...definition,
        instructions: `${definition.instructions} More.`,
      }),
    ).not.toBe(provider.agentFingerprint(definition));
    // The API's address after the domain move: Retell's webhooks have to follow it.
    expect(at("https://app.callmate.example.com").agentFingerprint(definition)).not.toBe(
      provider.agentFingerprint(definition),
    );
  });
});

describe("RetellVoiceProvider agents", () => {
  it("builds the flow the spike proved: static opening, scripts as uninterruptible global nodes, static close", () => {
    const definition = sampleAgentDefinition();
    const flow = buildConversationFlow(definition);
    const byId = Object.fromEntries(flow.nodes.map((node) => [node.id, node]));

    expect(flow).toMatchObject({
      start_speaker: "agent",
      start_node_id: "opening",
      global_prompt: definition.instructions,
    });
    expect(flow.model_config).toBeDefined(); // the API rejects a flow without it
    expect(byId.opening).toMatchObject({
      instruction: { type: "static_text", text: definition.opening },
      interruption_sensitivity: 0,
    });
    for (const script of definition.scripts) {
      expect(byId[script.id], script.id).toMatchObject({
        instruction: { type: "static_text", text: script.text },
        interruption_sensitivity: 0,
        global_node_setting: {
          condition: script.trigger,
          // Once a call for the water message; the gas and 999 messages may be spoken again.
          cool_down: script.id === "water_leak" ? COOL_DOWN_ONCE_PER_CALL : 1,
        },
        edges: [{ destination_node_id: "take_message" }],
      });
    }
    expect(byId.close).toMatchObject({
      type: "end",
      instruction: { type: "static_text", text: definition.close },
    });
    // The close condition is the definition's, which the eval simulation uses too.
    expect(byId.take_message).toMatchObject({
      edges: [
        {
          transition_condition: { type: "prompt", prompt: definition.closeWhen },
          destination_node_id: "close",
        },
      ],
    });
    // No script text leaks into the model's prompt node.
    expect(JSON.stringify(byId.take_message)).not.toContain("0800 111 999");
  });

  it("adds the emergency tools and alert nodes only when a function URL is set", () => {
    const definition = sampleAgentDefinition();
    const plain = buildConversationFlow(definition);
    expect(plain).not.toHaveProperty("tools");
    expect(plain.nodes.some((node) => node.type === "function")).toBe(false);

    const url = "https://example.com/webhooks/voice/retell/function";
    const flow = buildConversationFlow(definition, url);
    const byId = Object.fromEntries(flow.nodes.map((node) => [node.id, node]));
    expect(flow.tools?.map((tool) => tool.name).sort()).toEqual([
      "danger_alert",
      "gas_emergency_alert",
    ]);
    for (const tool of flow.tools ?? []) {
      expect(tool).toMatchObject({ type: "custom", url, method: "POST", max_retry: 1 });
    }
    // Gas script -> its alert node -> take the message; the water script still goes straight on.
    expect(byId.gas_emergency).toMatchObject({
      edges: [{ destination_node_id: "gas_emergency_alert" }],
    });
    expect(byId.gas_emergency_alert).toMatchObject({
      type: "function",
      tool_id: "gas_emergency_alert",
      wait_for_result: false,
      speak_during_execution: false,
      edges: [{ destination_node_id: "take_message" }],
      else_edge: { destination_node_id: "take_message" },
    });
    expect(byId.water_leak).toMatchObject({ edges: [{ destination_node_id: "take_message" }] });
  });

  it("maps the limits, language, voice and greeting delay onto the agent", () => {
    const agent = buildAgent(sampleAgentDefinition(), "https://example.com/webhooks/voice/retell");
    expect(agent).toMatchObject({
      voice_id: "retell-Willa",
      language: "en-GB",
      begin_message_delay_ms: 1000,
      max_call_duration_ms: 180_000,
      reminder_trigger_ms: 5_000,
      reminder_max_count: 1,
      end_call_after_silence_ms: 10_000,
      webhook_url: "https://example.com/webhooks/voice/retell",
      opt_in_signed_url: true,
      data_storage_retention_days: 30,
    });
    expect(buildAgent(sampleAgentDefinition({ voice: { gender: "male" } }))).toMatchObject({
      voice_id: "11labs-Anthony",
      fallback_voice_ids: expect.any(Array) as unknown,
    });
    expect(buildAgent(sampleAgentDefinition())).not.toHaveProperty("webhook_url");
  });

  it("updates an existing agent's flow and settings in place, with no new agent", async () => {
    const { provider, stub } = makeStubHarness();
    const { providerAgentId } = await provider.upsertAgent({
      definition: sampleAgentDefinition({ profileVersion: 1 }),
      existingProviderAgentId: null,
    });
    stub.requests.length = 0;

    await provider.upsertAgent({
      definition: sampleAgentDefinition({ profileVersion: 2 }),
      existingProviderAgentId: providerAgentId,
    });
    expect(stub.requests.map((r) => `${r.method} ${r.path.split("/")[1]}`)).toEqual([
      "GET get-agent",
      "PATCH update-conversation-flow",
      "PATCH update-agent",
    ]);
    expect(stub.agents.size).toBe(1);
    expect(stub.agents.get(providerAgentId)?.body).toMatchObject({
      agent_name: expect.stringContaining("v2") as unknown,
    });
  });

  it("creates a fresh agent when the one it knew about no longer exists at Retell", async () => {
    const { provider, stub } = makeStubHarness();
    const { providerAgentId } = await provider.upsertAgent({
      definition: sampleAgentDefinition(),
      existingProviderAgentId: "agent_deleted_by_hand",
    });
    expect(providerAgentId).toMatch(/^agent_stub/);
    expect(stub.agents.size).toBe(1);
  });

  it("treats deleting call data that's already gone as success", async () => {
    const { provider, stub } = makeStubHarness();
    await provider.deleteCallData("call_1");
    await expect(provider.deleteCallData("call_1")).resolves.toBeUndefined();
    expect(stub.deletedCalls).toEqual(new Set(["call_1"]));
  });
});

describe("RetellVoiceProvider calls", () => {
  it("registers an inbound call with the agent, numbers and variables, and returns the SIP URI", async () => {
    const { provider, stub } = makeStubHarness();
    const { providerAgentId } = await provider.upsertAgent({
      definition: sampleAgentDefinition(),
      existingProviderAgentId: null,
    });
    const { sipUri } = await provider.registerInboundCall({
      providerAgentId,
      from: "+447700900123",
      to: "+441632960001",
      variables: { open_now: "no", holiday_mode: "yes" },
    });
    expect(sipUri).toBe("sip:call_stub1@sip.retellai.com");
    expect(stub.calls[0]).toEqual({
      agent_id: providerAgentId,
      direction: "inbound",
      from_number: "+447700900123",
      to_number: "+441632960001",
      retell_llm_dynamic_variables: { open_now: "no", holiday_mode: "yes" },
    });
  });

  it("leaves the caller's number out when it was withheld", async () => {
    const { provider, stub } = makeStubHarness();
    const { providerAgentId } = await provider.upsertAgent({
      definition: sampleAgentDefinition(),
      existingProviderAgentId: null,
    });
    await provider.registerInboundCall({
      providerAgentId,
      from: null,
      to: "+441632960001",
      variables: {},
    });
    expect(stub.calls[0]).not.toHaveProperty("from_number");
  });
});

// ─── Against the real Retell API ───────────────────────────────────────────────────────
// Creates (and deletes) real agents on the trial account. Never runs in CI: it needs
// RETELL_LIVE_TESTS=1 and RETELL_API_KEY in the environment.
//   PowerShell: $env:RETELL_LIVE_TESTS = "1"; npx vitest run apps/api/src/providers/retell.test.ts
describe.runIf(process.env.RETELL_LIVE_TESTS === "1" && process.env.RETELL_API_KEY)(
  "live Retell",
  () => {
    const apiKey = process.env.RETELL_API_KEY!;
    const created: string[] = [];

    // Deleting an agent at Retell doesn't delete its conversation flow, so both go.
    afterAll(async () => {
      const headers = { Authorization: `Bearer ${apiKey}` };
      for (const agentId of created) {
        const agent = (await fetch(`https://api.retellai.com/get-agent/${agentId}`, {
          headers,
        }).then((r) => r.json())) as { response_engine?: { conversation_flow_id?: string } };
        await fetch(`https://api.retellai.com/delete-agent/${agentId}`, {
          method: "DELETE",
          headers,
        });
        const flowId = agent.response_engine?.conversation_flow_id;
        if (flowId) {
          await fetch(`https://api.retellai.com/delete-conversation-flow/${flowId}`, {
            method: "DELETE",
            headers,
          });
        }
      }
    });

    describeVoiceProviderContract(
      "Retell (live)",
      () => {
        // With a function URL, so the live run creates the flow with the emergency function nodes
        // (their edge shape is only documented, never confirmed, until this passes).
        const real = new RetellVoiceProvider({
          apiKey,
          webhookUrl: "https://example.com/webhooks/voice/retell",
          functionUrl: "https://example.com/webhooks/voice/retell/function",
        });
        const provider: typeof real = Object.assign(Object.create(real) as typeof real, {
          upsertAgent: async (input: Parameters<typeof real.upsertAgent>[0]) => {
            const result = await real.upsertAgent(input);
            if (!created.includes(result.providerAgentId)) created.push(result.providerAgentId);
            return result;
          },
        });
        return {
          provider,
          signedWebhook: (event) => signed(retellPayload(event), { apiKey, at: Date.now() }),
          ignorableWebhook: () =>
            signed(
              { event: "call_started", call: retellPayload(sampleCallEndedEvent()).call },
              { apiKey, at: Date.now() },
            ),
        };
      },
      { canRegisterCalls: false },
    );
  },
);

describe("RetellVoiceProvider listEndedCalls", () => {
  it("filters for ended phone calls since the window start, pages through, and fetches each call", async () => {
    const { provider, stub } = makeStubHarness();
    stub.listCallsPageSize = 2;
    const events = [1, 2, 3].map((n) => ({
      ...retellShapedEvent(),
      providerCallId: `call_listed_${n}`,
    }));
    for (const event of events) {
      const { call } = retellPayload(event);
      stub.listedCalls.push({
        call_id: event.providerCallId,
        start_timestamp: call.start_timestamp,
      });
      stub.callRecords.set(event.providerCallId, call);
    }
    // A web call in the account: listed by Retell but useless to us (no dialled number).
    stub.listedCalls.push({ call_id: "call_web" });
    stub.callRecords.set("call_web", {
      ...retellPayload(events[0]!).call,
      call_id: "call_web",
      call_type: "web_call",
      to_number: undefined,
      from_number: undefined,
    });

    const since = new Date("2026-11-06T00:00:00Z");
    const listed = await provider.listEndedCalls({ since });
    expect(listed.map((e) => e.providerCallId)).toEqual([
      "call_listed_1",
      "call_listed_2",
      "call_listed_3",
    ]);
    expect(listed[0]).toEqual(events[0]);

    const listRequests = stub.requests.filter((r) => r.path === "/v3/list-calls");
    expect(listRequests).toHaveLength(2); // two pages
    expect(listRequests[0]!.body).toMatchObject({
      filter_criteria: {
        call_type: { type: "enum", op: "in", value: ["phone_call"] },
        call_status: { type: "enum", op: "in", value: ["ended"] },
        start_timestamp: {
          type: "range",
          op: "bt",
          value: [since.getTime(), expect.any(Number) as unknown],
        },
      },
      limit: 1000,
    });
    expect(stub.requests.filter((r) => r.path.startsWith("/v2/get-call/"))).toHaveLength(4);
  });

  // Every 15 minutes over the last day, nearly every call listed was stored by its webhook.
  it("doesn't fetch the calls already stored, asking once per page which they are", async () => {
    const { provider, stub } = makeStubHarness();
    stub.listCallsPageSize = 2;
    const events = [1, 2, 3].map((n) => ({
      ...retellShapedEvent(),
      providerCallId: `call_known_${n}`,
    }));
    for (const event of events) {
      const { call } = retellPayload(event);
      stub.listedCalls.push({
        call_id: event.providerCallId,
        start_timestamp: call.start_timestamp,
      });
      stub.callRecords.set(event.providerCallId, call);
    }
    const asked: string[][] = [];
    const listed = await provider.listEndedCalls({
      since: new Date("2026-11-06T00:00:00Z"),
      alreadyStored: (ids) => {
        asked.push(ids);
        return Promise.resolve(new Set(ids.filter((id) => id !== "call_known_2")));
      },
    });
    expect(listed.map((e) => e.providerCallId)).toEqual(["call_known_2"]);
    expect(asked).toHaveLength(2); // one question a page
    expect(
      stub.requests.filter((r) => r.path.startsWith("/v2/get-call/")).map((r) => r.path),
    ).toEqual(["/v2/get-call/call_known_2"]);
  });
});

describe("RetellVoiceProvider edge cases", () => {
  const provider = () => new RetellVoiceProvider({ apiKey: TEST_API_KEY, now: () => NOW });

  it("floors the call length, so a 4.9-second call is 4 seconds and isn't billed", () => {
    const { rawBody, headers } = signed(retellPayload(retellShapedEvent(), { duration_ms: 4900 }));
    expect(provider().verifyAndParseWebhook(rawBody, headers)).toMatchObject({
      durationSeconds: 4,
    });
  });

  it("rejects a correctly signed body that isn't JSON instead of throwing a SyntaxError", () => {
    const rawBody = Buffer.from("not json at all");
    const headers = {
      "x-retell-signature": signRetellWebhook(rawBody, TEST_API_KEY, NOW.getTime()),
    };
    expect(() => provider().verifyAndParseWebhook(rawBody, headers)).toThrow(
      WebhookVerificationError,
    );
    expect(() => provider().verifyAndParseFunctionCall(rawBody, headers)).toThrow(
      WebhookVerificationError,
    );
  });
});

describe("RetellVoiceProvider webhook key", () => {
  it("verifies with the dedicated webhook key when one is configured, not the REST key", () => {
    const provider = new RetellVoiceProvider({
      apiKey: "rest-key-without-the-badge",
      webhookKey: TEST_API_KEY,
      now: () => NOW,
    });
    const { rawBody, headers } = signed(retellPayload(retellShapedEvent()));
    expect(provider.verifyAndParseWebhook(rawBody, headers)).toMatchObject({ type: "call_ended" });
    const wrongKey = new RetellVoiceProvider({
      apiKey: "rest-key-without-the-badge",
      now: () => NOW,
    });
    expect(() => wrongKey.verifyAndParseWebhook(rawBody, headers)).toThrow(
      WebhookVerificationError,
    );
  });
});

describe("RetellVoiceProvider.deleteAgent", () => {
  async function agentAtRetell() {
    const { stub, provider } = makeStubHarness();
    const { providerAgentId } = await provider.upsertAgent({
      definition: sampleAgentDefinition(),
      existingProviderAgentId: null,
    });
    return { stub, provider, providerAgentId, flowId: stub.agents.get(providerAgentId)!.flowId };
  }

  it("deletes the flow while the agent still uses it, then the agent", async () => {
    const { stub, provider, providerAgentId, flowId } = await agentAtRetell();
    await provider.deleteAgent(providerAgentId);
    expect(stub.flows.has(flowId)).toBe(false);
    expect(stub.agents.has(providerAgentId)).toBe(false);
  });

  it("finishes on a retry after a run that stopped between the flow and the agent", async () => {
    const { stub, provider, providerAgentId, flowId } = await agentAtRetell();
    stub.flows.delete(flowId); // as far as the earlier run got
    await provider.deleteAgent(providerAgentId);
    expect(stub.agents.has(providerAgentId)).toBe(false);
  });

  it("takes Retell's 422 for an agent it can't find as already deleted", async () => {
    const stub = new RetellApiStub();
    const cannotFind: typeof fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url.includes("/get-agent/")
        ? Promise.resolve(
            Response.json(
              { message: "Cannot find requested asset under given api key." },
              { status: 422 },
            ),
          )
        : stub.fetch(input, init);
    };
    const provider = new RetellVoiceProvider({ apiKey: TEST_API_KEY, fetch: cannotFind });
    await expect(provider.deleteAgent("agent_gone")).resolves.toBeUndefined();
  });
});
