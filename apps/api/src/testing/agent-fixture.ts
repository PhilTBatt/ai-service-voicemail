import type { AgentDefinition } from "../core/agent.ts";
import type { CallEndedEvent } from "../providers/voice.ts";
import { SEED_TENANTS } from "../db/seed.ts";

// Fictional data only: the seed's demo tenant and Ofcom drama numbers.

export function sampleAgentDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    tenantId: SEED_TENANTS[0]!.id,
    profileVersion: 1,
    language: "en-GB",
    timezone: "Europe/London",
    voice: { gender: "female" },
    opening:
      "Hi, you're through to Ant's Plumbing. I'm their AI assistant. This call is recorded and transcribed so Ant can call you back. How can I help?",
    instructions: "Take a message for Ant. Never quote prices.",
    scripts: [
      {
        id: "danger",
        trigger: "Sparks, a burning smell, smoke or fire.",
        text: "If anyone is in danger, or there's a fire or smoke, please hang up now and call 999.",
      },
    ],
    close: "Thanks. I've passed that to Ant, who'll aim to get back to you.",
    limits: {
      maxCallSeconds: 480,
      silenceReminderSeconds: 5,
      endAfterSilenceSeconds: 10,
      beginMessageDelayMs: 1000,
    },
    ...overrides,
  };
}

export function sampleCallEndedEvent(overrides: Partial<CallEndedEvent> = {}): CallEndedEvent {
  return {
    type: "call_ended",
    providerCallId: "call_fixture_0001",
    providerAgentId: "fake_agent_1",
    dialledNumber: SEED_TENANTS[0]!.phoneNumber,
    callerNumber: "+447700900123",
    startedAt: new Date("2026-11-06T09:00:00Z"),
    endedAt: new Date("2026-11-06T09:01:30Z"),
    durationSeconds: 90,
    endReason: "agent_hangup",
    transcript: [
      { role: "agent", text: "Hi, you're through to Ant's Plumbing." },
      { role: "caller", text: "My kitchen tap is dripping." },
    ],
    recordingRef: "rec_fixture_0001",
    costs: [{ component: "voice_minutes", units: 90, unitType: "seconds" }],
    ...overrides,
  };
}
