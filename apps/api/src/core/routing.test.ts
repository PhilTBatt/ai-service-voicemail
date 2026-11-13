import { TENANT_STATUSES, type TenantStatus } from "@callmate/shared";
import { describe, expect, it } from "vitest";
import {
  DEMO_DAILY_CALLS_PER_CALLER,
  DEMO_DAILY_CALLS_WITHHELD,
  routeInboundCall,
  type InboundCallContext,
} from "./routing.ts";

const NOW = new Date("2026-07-15T10:00:00Z"); // Wednesday 11:00 BST
const AVAILABILITY = {
  openingHours: { wed: { open: "08:00", close: "18:00" } },
  holidayMode: false,
  holidayUntil: null,
};

function context(
  status: TenantStatus,
  overrides: Partial<InboundCallContext> = {},
): InboundCallContext {
  return {
    tenant: {
      id: "00000000-0000-4000-8000-000000000001",
      status,
      notificationMobile: "+447700900001",
      providerAgentId: "agent_1",
      availability: AVAILABILITY,
    },
    callerNumber: "+447700900123",
    callerBlocked: false,
    killSwitchOn: false,
    callerCallsToday: 0,
    ...overrides,
  };
}

const EXPECTED: Record<TenantStatus, string> = {
  live: "agent",
  demo: "agent",
  paused: "voicemail",
  suspended: "voicemail",
  onboarding: "voicemail",
  cancelling: "ended",
  cancelled: "ended",
};

describe("routeInboundCall", () => {
  it.each(TENANT_STATUSES)("routes a %s tenant", (status) => {
    expect(routeInboundCall(context(status), NOW).kind).toBe(EXPECTED[status]);
  });

  it("sends a live tenant's call to the agent with the per-call variables", () => {
    expect(routeInboundCall(context("live"), NOW)).toEqual({
      kind: "agent",
      providerAgentId: "agent_1",
      variables: {
        open_now: "yes",
        holiday_mode: "no",
        holiday_until: "not away",
        caller_number: "07700 900123",
      },
    });
  });

  it("gives the ended message the business mobile to read out", () => {
    expect(routeInboundCall(context("cancelled"), NOW)).toEqual({
      kind: "ended",
      mobile: "+447700900001",
    });
  });

  it.each(TENANT_STATUSES)(
    "sends every status to voicemail while the kill switch is on (%s)",
    (status) => {
      expect(routeInboundCall(context(status, { killSwitchOn: true }), NOW)).toEqual({
        kind: "voicemail",
        reason: "kill switch on",
      });
    },
  );

  it("sends a live tenant whose agent hasn't synced to voicemail rather than dead air", () => {
    const live = context("live");
    live.tenant!.providerAgentId = null;
    expect(routeInboundCall(live, NOW)).toMatchObject({
      kind: "voicemail",
      reason: "agent not synced yet",
    });
  });

  it("rejects a blocked caller", () => {
    expect(routeInboundCall(context("live", { callerBlocked: true }), NOW)).toMatchObject({
      kind: "reject",
    });
  });

  it("sends a number nobody owns to voicemail", () => {
    expect(routeInboundCall(context("live", { tenant: null }), NOW)).toMatchObject({
      kind: "voicemail",
    });
  });
});

describe("the demo line's daily cap", () => {
  it("lets a caller through until they've used today's calls, then plays the limit message", () => {
    expect(
      routeInboundCall(context("demo", { callerCallsToday: DEMO_DAILY_CALLS_PER_CALLER - 1 }), NOW)
        .kind,
    ).toBe("agent");
    expect(
      routeInboundCall(context("demo", { callerCallsToday: DEMO_DAILY_CALLS_PER_CALLER }), NOW),
    ).toEqual({ kind: "demo-limit", withheld: false });
  });

  it("never caps a paying tenant's callers", () => {
    expect(routeInboundCall(context("live", { callerCallsToday: 50 }), NOW).kind).toBe("agent");
  });

  it("still blocks and kill-switches before the cap", () => {
    expect(
      routeInboundCall(context("demo", { callerCallsToday: 9, callerBlocked: true }), NOW).kind,
    ).toBe("reject");
    expect(
      routeInboundCall(context("demo", { callerCallsToday: 9, killSwitchOn: true }), NOW).kind,
    ).toBe("voicemail");
  });
});

describe("the caller's number as a per-call variable", () => {
  it('hands the agent the caller\'s number in UK format, or "unknown" when withheld', () => {
    const shown = routeInboundCall(context("live"), NOW);
    expect(shown).toMatchObject({ variables: { caller_number: "07700 900123" } });
    const withheld = routeInboundCall(context("live", { callerNumber: null }), NOW);
    expect(withheld).toMatchObject({ variables: { caller_number: "unknown" } });
  });
});

// Phil, 2026-11-11 (PROGRESS open question 5): withheld callers share one allowance, bigger than
// a phone's, so a prospect dialling 141 isn't told the demo's used up by someone else.
describe("the demo cap for withheld callers", () => {
  it("lets them through past a phone's allowance, up to their own shared one", () => {
    const withheld = (callerCallsToday: number) =>
      routeInboundCall(context("demo", { callerNumber: null, callerCallsToday }), NOW);
    expect(DEMO_DAILY_CALLS_WITHHELD).toBeGreaterThan(DEMO_DAILY_CALLS_PER_CALLER);
    expect(withheld(DEMO_DAILY_CALLS_PER_CALLER).kind).toBe("agent");
    expect(withheld(DEMO_DAILY_CALLS_WITHHELD - 1).kind).toBe("agent");
    expect(withheld(DEMO_DAILY_CALLS_WITHHELD)).toEqual({ kind: "demo-limit", withheld: true });
  });

  it("tells a phone's limit apart from the shared one, so each hears its own message", () => {
    expect(
      routeInboundCall(context("demo", { callerCallsToday: DEMO_DAILY_CALLS_PER_CALLER }), NOW),
    ).toEqual({ kind: "demo-limit", withheld: false });
  });
});

describe("the demo cap and the owner's own phone", () => {
  it("never caps calls from the tenant's registered mobile", () => {
    const owner = context("demo", { callerNumber: "+447700900001", callerCallsToday: 40 });
    expect(routeInboundCall(owner, NOW).kind).toBe("agent");
    const prospect = context("demo", {
      callerNumber: "+447700900555",
      callerCallsToday: DEMO_DAILY_CALLS_PER_CALLER,
    });
    expect(routeInboundCall(prospect, NOW).kind).toBe("demo-limit");
  });
});
