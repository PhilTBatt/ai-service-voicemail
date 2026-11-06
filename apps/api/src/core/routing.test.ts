import { TENANT_STATUSES, type TenantStatus } from "@callmate/shared";
import { describe, expect, it } from "vitest";
import { routeInboundCall, type InboundCallContext } from "./routing.ts";

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
    callerBlocked: false,
    killSwitchOn: false,
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
      variables: { open_now: "yes", holiday_mode: "no" },
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
