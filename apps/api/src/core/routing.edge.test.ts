// Every combination of what routing reads, against CLAUDE.md's rules that must never break: no
// caller hits dead air, paused and suspended tenants get the fallback voicemail, cancelled ones
// the "service has ended" message, and the kill switch beats everything.
import { TENANT_STATUSES, type TenantStatus } from "@callmate/shared";
import { describe, expect, it } from "vitest";
import {
  DEMO_DAILY_CALLS_PER_CALLER,
  DEMO_DAILY_CALLS_WITHHELD,
  routeInboundCall,
  type InboundCallContext,
  type RouteDecision,
} from "./routing.ts";

const NOW = new Date("2026-07-15T10:00:00Z"); // Wednesday 11:00 BST
const OWNER = "+447700900001";
const CALLER = "+447700900123";

function context(
  status: TenantStatus,
  overrides: Partial<InboundCallContext> = {},
  tenant: Partial<NonNullable<InboundCallContext["tenant"]>> = {},
): InboundCallContext {
  return {
    tenant: {
      id: "00000000-0000-4000-8000-000000000002",
      status,
      notificationMobile: OWNER,
      providerAgentId: "agent_1",
      availability: {
        openingHours: { wed: { open: "08:00", close: "18:00" } },
        holidayMode: false,
        holidayUntil: null,
      },
      ...tenant,
    },
    callerNumber: CALLER,
    callerBlocked: false,
    killSwitchOn: false,
    callerCallsToday: 0,
    ...overrides,
  };
}

const KINDS: RouteDecision["kind"][] = ["agent", "voicemail", "ended", "reject", "demo-limit"];

describe("routeInboundCall, every combination", () => {
  const combos = TENANT_STATUSES.flatMap((status) =>
    [false, true].flatMap((killSwitchOn) =>
      [false, true].flatMap((callerBlocked) =>
        [false, true].flatMap((synced) =>
          [null, CALLER, OWNER].flatMap((callerNumber) =>
            [0, DEMO_DAILY_CALLS_PER_CALLER, 1000].map((callerCallsToday) => ({
              status,
              killSwitchOn,
              callerBlocked,
              synced,
              callerNumber,
              callerCallsToday,
            })),
          ),
        ),
      ),
    ),
  );

  it(`always gives the caller something to hear (${combos.length} combinations)`, () => {
    for (const combo of combos) {
      const decision = routeInboundCall(
        context(
          combo.status,
          {
            killSwitchOn: combo.killSwitchOn,
            callerBlocked: combo.callerBlocked,
            callerNumber: combo.callerNumber,
            callerCallsToday: combo.callerCallsToday,
          },
          { providerAgentId: combo.synced ? "agent_1" : null },
        ),
        NOW,
      );
      const label = JSON.stringify(combo);
      expect(KINDS, label).toContain(decision.kind);
      // The kill switch beats everything, blocked callers included.
      if (combo.killSwitchOn)
        expect(decision, label).toEqual({ kind: "voicemail", reason: "kill switch on" });
      else if (combo.callerBlocked) expect(decision.kind, label).toBe("reject");
      // Only a live or demo tenant with a synced agent ever reaches the agent.
      if (decision.kind === "agent") {
        expect(["live", "demo"], label).toContain(combo.status);
        expect(combo.synced, label).toBe(true);
      }
      // Paused, suspended and onboarding: the voicemail, never the agent or the ended message.
      if (
        !combo.killSwitchOn &&
        !combo.callerBlocked &&
        ["paused", "suspended", "onboarding"].includes(combo.status)
      ) {
        expect(decision, label).toEqual({ kind: "voicemail", reason: `tenant is ${combo.status}` });
      }
      // Cancelling and cancelled: the "service has ended" message with the mobile.
      if (
        !combo.killSwitchOn &&
        !combo.callerBlocked &&
        (combo.status === "cancelled" || combo.status === "cancelling")
      ) {
        expect(decision, label).toEqual({ kind: "ended", mobile: OWNER });
      }
      // Only the demo line is ever capped.
      if (decision.kind === "demo-limit") expect(combo.status, label).toBe("demo");
    }
  });

  it("sends a call to a number nobody owns to the voicemail, even from a blocked caller", () => {
    expect(
      routeInboundCall({ ...context("live"), tenant: null, callerBlocked: true }, NOW),
    ).toEqual({ kind: "voicemail", reason: "no tenant for the dialled number" });
  });
});

describe("routeInboundCall, the demo line's cap", () => {
  it.each([
    [DEMO_DAILY_CALLS_PER_CALLER - 1, "agent"],
    [DEMO_DAILY_CALLS_PER_CALLER, "demo-limit"],
    [DEMO_DAILY_CALLS_PER_CALLER + 1, "demo-limit"],
  ])("with %i calls today, routes to %s", (callerCallsToday, kind) => {
    expect(routeInboundCall(context("demo", { callerCallsToday }), NOW).kind).toBe(kind);
  });

  it("never caps the owner's own mobile", () => {
    expect(
      routeInboundCall(context("demo", { callerNumber: OWNER, callerCallsToday: 500 }), NOW).kind,
    ).toBe("agent");
  });

  it("caps withheld callers even when the business has no mobile on record", () => {
    // A withheld caller (null) used to match a missing mobile (null) and count as the owner.
    // Withheld callers share their own, bigger allowance (DEMO_DAILY_CALLS_WITHHELD).
    expect(
      routeInboundCall(
        context(
          "demo",
          { callerNumber: null, callerCallsToday: DEMO_DAILY_CALLS_WITHHELD },
          { notificationMobile: null },
        ),
        NOW,
      ),
    ).toEqual({ kind: "demo-limit", withheld: true });
  });

  it("never caps a live tenant's callers, however many calls", () => {
    expect(routeInboundCall(context("live", { callerCallsToday: 10_000 }), NOW).kind).toBe("agent");
  });
});

describe("routeInboundCall, what the agent is told", () => {
  it("says 'unknown' for a withheld caller, never 'null'", () => {
    const decision = routeInboundCall(context("live", { callerNumber: null }), NOW);
    expect(decision).toMatchObject({ kind: "agent", variables: { caller_number: "unknown" } });
  });

  it("speaks a UK mobile in its national form", () => {
    const decision = routeInboundCall(context("live"), NOW);
    expect(decision).toMatchObject({ variables: { caller_number: "07700 900123" } });
  });

  it("gives every variable as a string, so the platform never sees an undefined", () => {
    const decision = routeInboundCall(
      context(
        "live",
        {},
        {
          availability: { openingHours: {}, holidayMode: true, holidayUntil: "2026-07-20" },
        },
      ),
      NOW,
    );
    if (decision.kind !== "agent") throw new Error(`expected the agent, got ${decision.kind}`);
    expect(decision.variables).toEqual({
      open_now: "no",
      holiday_mode: "yes",
      holiday_until: "until 20 July 2026",
      caller_number: "07700 900123",
    });
  });

  it("tells a cancelled tenant's caller the service has ended even with no mobile on record", () => {
    expect(routeInboundCall(context("cancelled", {}, { notificationMobile: null }), NOW)).toEqual({
      kind: "ended",
      mobile: null,
    });
  });
});
