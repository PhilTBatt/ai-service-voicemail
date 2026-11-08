import { describe, expect, it } from "vitest";
import { FakeLlmProvider } from "../providers/llm.fake.ts";
import { sampleAgentDefinition } from "../testing/agent-fixture.ts";
import { CostMeter } from "./cost.ts";
import { parsePersona, type Persona } from "./persona.ts";
import { agentSystemPrompt, callerSystemPrompt, simulateCall } from "./simulate.ts";

const definition = sampleAgentDefinition();
const gas = definition.scripts.find((s) => s.id === "gas_emergency")!;

const persona = (yaml: string): Persona => parsePersona(yaml, "test.yaml");
const meter = () => new CostMeter({ model: "fake-model", capPence: 0 });

const chatty = persona(`
id: chatty
name: Chatty
description: x
caller:
  brief: You have a dripping tap.
  name: Sam
  phone: "07700 900123"
  postcode: XQ12 3JL
  opening: "Hi, my tap is dripping."
expect: {}
`);

describe("simulateCall", () => {
  it("opens with the disclosure, alternates turns, and ends with the closing line when the agent is done", async () => {
    const llm = new FakeLlmProvider()
      // Turn 1: the caller's opening is fixed, so the first model call is the agent's.
      .willReturn({
        trigger: "none",
        reply: "Sorry to hear that. Can I take your name?",
        done: false,
      })
      .willReturn({ say: "It's Sam.", hangUp: false })
      .willReturn({ trigger: "none", reply: "Thanks Sam.", done: true });

    const result = await simulateCall({ llm, meter: meter() }, definition, chatty);
    expect(result.ending).toBe("close");
    expect(result.transcript).toEqual([
      { role: "agent", text: definition.opening },
      { role: "caller", text: "Hi, my tap is dripping." },
      { role: "agent", text: "Sorry to hear that. Can I take your name?" },
      { role: "caller", text: "It's Sam." },
      { role: "agent", text: "Thanks Sam." },
      { role: "agent", text: definition.close },
    ]);
    expect(result.scriptsSpoken).toEqual([]);
    // The caller model saw the persona's details; the agent model saw the instructions.
    expect(llm.requests[1]?.system).toContain("Your name is Sam.");
    expect(llm.requests[0]?.system).toContain("You are the AI phone assistant");
  });

  it("speaks a triggered script word for word instead of the model's reply, then carries on", async () => {
    const llm = new FakeLlmProvider()
      .willReturn({ trigger: "gas_emergency", reply: "Please call 0800 111 999 now.", done: false })
      .willReturn({ say: "Oh right, okay. It's Sam.", hangUp: false })
      // The same script can't fire on two consecutive agent turns (the flow's cool-down).
      .willReturn({ trigger: "gas_emergency", reply: "Can I take your number?", done: false })
      .willReturn({ say: "07700 900123.", hangUp: false })
      .willReturn({ trigger: "none", reply: "Thanks.", done: true });

    const result = await simulateCall({ llm, meter: meter() }, definition, chatty);
    const agentTurns = result.transcript.filter((t) => t.role === "agent").map((t) => t.text);
    expect(agentTurns).toEqual([
      definition.opening,
      gas.text,
      "Can I take your number?",
      "Thanks.",
      definition.close,
    ]);
    expect(agentTurns).not.toContain("Please call 0800 111 999 now.");
    expect(result.scriptsSpoken).toEqual(["gas_emergency"]);
  });

  it("ends when the caller hangs up", async () => {
    const llm = new FakeLlmProvider()
      .willReturn({ trigger: "none", reply: "How can I help?", done: false })
      .willReturn({ say: "Sorry, wrong number.", hangUp: true });
    const result = await simulateCall({ llm, meter: meter() }, definition, chatty);
    expect(result.ending).toBe("caller");
    expect(result.transcript.at(-1)).toEqual({ role: "caller", text: "Sorry, wrong number." });
  });

  it("prompts a silent caller once, then ends the call without the closing line", async () => {
    const silent = persona(`
id: silent
name: Silent
description: x
caller:
  brief: You say nothing.
  silent: true
expect:
  maxTurns: 6
`);
    const llm = new FakeLlmProvider().willReturn({
      trigger: "none",
      reply: "Hello, are you still there?",
      done: false,
    });
    const result = await simulateCall({ llm, meter: meter() }, definition, silent);
    expect(result.ending).toBe("silence");
    expect(result.transcript).toEqual([
      { role: "agent", text: definition.opening },
      { role: "caller", text: "" },
      { role: "agent", text: "Hello, are you still there?" },
      { role: "caller", text: "" },
    ]);
    expect(llm.requests).toHaveLength(1); // no caller model calls for a silent persona
  });

  it("hangs up after the persona's turn limit, and stops at the max turns", async () => {
    const brief = persona(`
id: brief
name: Brief
description: x
caller:
  brief: Robocall.
  opening: "Press one."
  hangsUpAfterTurns: 2
expect:
  maxTurns: 10
`);
    const llm = new FakeLlmProvider()
      .willReturn({ trigger: "none", reply: "Sorry, who's calling?", done: false })
      .willReturn({ say: "Press one.", hangUp: false });
    const result = await simulateCall({ llm, meter: meter() }, definition, brief);
    expect(result.ending).toBe("caller");
    expect(result.transcript).toHaveLength(4);

    const endless = persona(`
id: endless
name: Endless
description: x
caller:
  brief: Talk forever.
  opening: "Hello."
expect:
  maxTurns: 4
`);
    const llm2 = new FakeLlmProvider()
      .willReturn({ trigger: "none", reply: "Hi.", done: false })
      .willReturn({ say: "Still here.", hangUp: false });
    const capped = await simulateCall({ llm: llm2, meter: meter() }, definition, endless);
    expect(capped.ending).toBe("max-turns");
    expect(capped.transcript).toHaveLength(4);
  });

  it("meters every model call and stops when the cap is passed", async () => {
    const llm = new FakeLlmProvider()
      .willReturn({ trigger: "none", reply: "Hi.", done: false })
      .willReturn({ say: "Hello.", hangUp: false })
      .willReturn({ trigger: "none", reply: "Bye.", done: true });
    const m = new CostMeter({ model: "fake-model", capPence: 0 });
    await simulateCall({ llm, meter: m }, definition, chatty);
    expect(m.calls).toBe(3);
    expect(m.inputTokens).toBe(300); // the fake reports 100 in, 20 out per call

    const strict = new CostMeter({ model: "claude-sonnet-5-5", capPence: 0 });
    const llm3 = new FakeLlmProvider().willReturn({ trigger: "none", reply: "Hi.", done: false });
    await expect(simulateCall({ llm: llm3, meter: strict }, definition, chatty)).rejects.toThrow(
      /cost/,
    );
  });

  it("substitutes the per-call variables into the agent's instructions", () => {
    const prompt = agentSystemPrompt(definition, { open_now: "no", holiday_mode: "yes" });
    expect(prompt).not.toContain("{{open_now}}");
    expect(prompt).toContain('If "no" is "no"');
    expect(prompt).toContain("- gas_emergency:");
  });

  it("speaks a once-a-call script only once, using the model's reply the second time", async () => {
    const water = definition.scripts.find((s) => s.id === "water_leak")!;
    expect(water.oncePerCall).toBe(true);
    const llm = new FakeLlmProvider()
      .willReturn({ trigger: "water_leak", reply: "Can I take your name?", done: false })
      .willReturn({ say: "I can't find the stopcock. It's Sam.", hangUp: false })
      .willReturn({ trigger: "none", reply: "Thanks Sam. What's your number?", done: false })
      .willReturn({ say: "07700 900123. It's still pouring in.", hangUp: false })
      // Not consecutive, so only the once-a-call rule holds it back.
      .willReturn({ trigger: "water_leak", reply: "Thanks. And your postcode?", done: false })
      .willReturn({ say: "XQ12 3JL.", hangUp: false })
      .willReturn({ trigger: "none", reply: "Thanks.", done: true });

    const result = await simulateCall({ llm, meter: meter() }, definition, chatty);
    const agentTurns = result.transcript.filter((t) => t.role === "agent").map((t) => t.text);
    expect(agentTurns.filter((text) => text === water.text)).toHaveLength(1);
    expect(agentTurns).toContain("Thanks. And your postcode?");
    expect(result.scriptsSpoken).toEqual(["water_leak"]);
  });

  it("tells the simulated caller to wait for the goodbye before hanging up", () => {
    // Three personas "hung up" on their last detail in the 2026-11-08 run, before the close.
    expect(callerSystemPrompt(chatty)).toContain("wait for the assistant to wind it up");
  });

  it("decides 'done' by the same condition as the platform's flow, and always asks for a reply", () => {
    const prompt = agentSystemPrompt(definition, {});
    expect(prompt).toContain(`"done": true when this holds: ${definition.closeWhen}.`);
    // The reply and the goodbye are spoken back to back, so a question there goes unanswered.
    expect(prompt).toContain('a reply with "done" mustn\'t ask anything');
    // A held-back script falls back to the reply: an empty one was dead air (2026-11-07).
    expect(prompt).toContain("Always fill it in, even when you name a trigger");
  });
});
