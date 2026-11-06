import type { AgentDefinition } from "../core/agent.ts";
import { buildAgentDefinition } from "../core/prompt-builder.ts";
import { SEED_TENANTS } from "../db/seed.ts";
import type { CallEndedEvent } from "../providers/voice.ts";
import { sampleProfile } from "./profile-fixture.ts";

// Fictional data only: the seed's demo tenant and Ofcom drama numbers.

/** The real builder's output for the sample profile, so fixtures can't drift from it. */
export function sampleAgentDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return { ...buildAgentDefinition(sampleProfile()), ...overrides };
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
