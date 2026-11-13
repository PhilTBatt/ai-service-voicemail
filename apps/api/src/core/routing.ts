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

/**
 * Demo tenants: each phone gets this many calls a day. BUILD_PLAN Step 9 said 3; Phil raised
 * it to 10 (2026-11-08) so Ant and prospects can try several scenarios. It still stops one
 * caller running up the bill once the number is handed out. The spoken message
 * (scripts.ts DEMO_LIMIT_LINE) says the number in words: twiml.test.ts keeps them in step.
 */
export const DEMO_DAILY_CALLS_PER_CALLER = 10;

/**
 * Callers who withhold their number share one allowance between them (otherwise dialling 141
 * first would get round the cap), a bigger one than a phone's, so a prospect who withholds their
 * number isn't told the demo's used up by someone else (Phil, 2026-11-11; PROGRESS open question
 * 5). The spoken message for them (scripts.ts DEMO_LIMIT_WITHHELD_LINE) names no number.
 */
export const DEMO_DAILY_CALLS_WITHHELD = 30;

export type RouteDecision =
  | { kind: "agent"; providerAgentId: string; variables: Record<string, string> }
  | { kind: "voicemail"; reason: string }
  | { kind: "ended"; mobile: string | null }
  | { kind: "reject"; reason: string }
  /** `withheld`: the shared allowance for callers with no number is used up, not a phone's own. */
  | { kind: "demo-limit"; withheld: boolean };

export function routeInboundCall(context: InboundCallContext, now: Date): RouteDecision {
  // The kill switch beats everything: one move sends every number to plain voicemail.
  if (context.killSwitchOn) return { kind: "voicemail", reason: "kill switch on" };
  if (!context.tenant) return { kind: "voicemail", reason: "no tenant for the dialled number" };
  if (context.callerBlocked) return { kind: "reject", reason: "caller is blocked" };

  const { tenant } = context;
  switch (tenant.status) {
    case "live":
    case "demo":
      // The registered mobile is the owner testing their own line: never capped. A withheld
      // caller is nobody in particular, even to a business with no mobile on record (null
      // matched null, and every withheld call went uncapped): they share their own allowance.
      if (tenant.status === "demo") {
        const withheld = context.callerNumber === null;
        const isOwner = !withheld && context.callerNumber === tenant.notificationMobile;
        const allowance = withheld ? DEMO_DAILY_CALLS_WITHHELD : DEMO_DAILY_CALLS_PER_CALLER;
        if (!isOwner && context.callerCallsToday >= allowance) {
          return { kind: "demo-limit", withheld };
        }
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
