// The fictional business each eval persona rings. A persona names its trade (persona.trade);
// the plumber is the demo tenant's own profile, the one Phil's test calls use, and each other
// trade is a stand-in built from that trade's template, so every template's wording gets
// tested. Fictional names only (CLAUDE.md).
import type { Trade } from "@callmate/shared";
import type { TenantProfile } from "../core/profile.ts";
import { buildAgentDefinition } from "../core/prompt-builder.ts";
import { sampleProfile } from "../testing/profile-fixture.ts";
import type { EvalAgent } from "./runner.ts";

/** The demo tenant's trade: the only one the live Retell batch can run against. */
export const DEMO_TRADE = "plumber" satisfies Trade;

const STAND_INS: Record<Exclude<Trade, typeof DEMO_TRADE>, { business: string; name: string }> = {
  electrician: { business: "Test Electrics", name: "Sam" },
  heating_engineer: { business: "Test Heating", name: "Lee" },
  roofer: { business: "Test Roofing", name: "Kit" },
  locksmith: { business: "Test Locks", name: "Jo" },
  general_builder: { business: "Test Builders", name: "Ray" },
};

export function evalProfile(trade: Trade): TenantProfile {
  if (trade === DEMO_TRADE) return sampleProfile({ isDemo: false });
  const { business, name } = STAND_INS[trade];
  // No services or FAQs of their own: the template's defaults are what's under test.
  return sampleProfile({
    isDemo: false,
    trade,
    businessName: business,
    tradespersonName: name,
    services: [],
    faqs: [],
  });
}

/** One agent per trade, built once. */
export function evalAgents(): (persona: { trade: Trade }) => EvalAgent {
  const built = new Map<Trade, EvalAgent>();
  return ({ trade }) => {
    let agent = built.get(trade);
    if (!agent) {
      const profile = evalProfile(trade);
      agent = {
        definition: buildAgentDefinition(profile),
        context: { businessName: profile.businessName, tradespersonName: profile.tradespersonName },
      };
      built.set(trade, agent);
    }
    return agent;
  };
}
