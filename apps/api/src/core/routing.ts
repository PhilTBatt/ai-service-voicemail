// Decides what a caller hears, from the tenant's status (BUILD_PLAN Step 4's table). A pure
// function: the route loads the facts, this decides, the TwiML builders speak.
import type { TenantStatus } from "@callmate/shared";
import { perCallVariables, type AvailabilityInput } from "./availability.ts";
import { nationalNumber } from "./notifications.ts";

export interface InboundCallContext {
  /** Null when no tenant owns the dialled number. */
  tenant: {
    id: string;
    status: TenantStatus;
    /** Spoken in the "service has ended" message. */
    notificationMobile: string | null;
    /** The synced platform agent, or null if the profile has never synced. */
    providerAgentId: string | null;
    availability: AvailabilityInput;
  } | null;
  /** E.164, or null when withheld. Offered to the caller as their call-back number. */
  callerNumber: string | null;
  callerBlocked: boolean;
  killSwitchOn: boolean;
  /** Calls from this caller to this tenant so far today (UK time). Only counted for demo tenants. */
  callerCallsToday: number;
}

/** Demo tenants: each phone gets this many calls a day (BUILD_PLAN Step 9). */
export const DEMO_DAILY_CALLS_PER_CALLER = 3;

export type RouteDecision =
  | { kind: "agent"; providerAgentId: string; variables: Record<string, string> }
  | { kind: "voicemail"; reason: string }
  | { kind: "ended"; mobile: string | null }
  | { kind: "reject"; reason: string }
  | { kind: "demo-limit" };

export function routeInboundCall(context: InboundCallContext, now: Date): RouteDecision {
  // The kill switch beats everything: one move sends every number to plain voicemail.
  if (context.killSwitchOn) return { kind: "voicemail", reason: "kill switch on" };
  if (!context.tenant) return { kind: "voicemail", reason: "no tenant for the dialled number" };
  if (context.callerBlocked) return { kind: "reject", reason: "caller is blocked" };

  const { tenant } = context;
  switch (tenant.status) {
    case "live":
    case "demo":
      if (tenant.status === "demo" && context.callerCallsToday >= DEMO_DAILY_CALLS_PER_CALLER) {
        return { kind: "demo-limit" };
      }
      if (!tenant.providerAgentId) return { kind: "voicemail", reason: "agent not synced yet" };
      return {
        kind: "agent",
        providerAgentId: tenant.providerAgentId,
        variables: {
          ...perCallVariables(tenant.availability, now),
          caller_number: context.callerNumber ? nationalNumber(context.callerNumber) : "unknown",
        },
      };
    case "cancelling":
    case "cancelled":
      return { kind: "ended", mobile: tenant.notificationMobile };
    case "onboarding":
    case "paused":
    case "suspended":
      return { kind: "voicemail", reason: `tenant is ${tenant.status}` };
  }
}
