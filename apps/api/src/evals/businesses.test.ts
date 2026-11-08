import { TRADES } from "@callmate/shared";
import { describe, expect, it } from "vitest";
import { buildAgentDefinition } from "../core/prompt-builder.ts";
import { TRADE_TEMPLATES } from "../core/trades/index.ts";
import { sampleProfile } from "../testing/profile-fixture.ts";
import { DEMO_TRADE, evalAgents, evalProfile } from "./businesses.ts";

describe("evalProfile", () => {
  it("rings the demo tenant's own profile for the demo trade", () => {
    expect(evalProfile(DEMO_TRADE)).toEqual(sampleProfile({ isDemo: false }));
  });

  it.each(TRADES.filter((trade) => trade !== DEMO_TRADE))(
    "builds a %s stand-in from the trade's own template",
    (trade) => {
      const profile = evalProfile(trade);
      expect(profile.trade).toBe(trade);
      expect(profile.isDemo).toBe(false);
      expect(profile.businessName).not.toBe("Ant's Plumbing");
      const { instructions } = buildAgentDefinition(profile);
      // No services or FAQs of its own, so the template's are the ones under test.
      for (const service of TRADE_TEMPLATES[trade].defaultServices) {
        expect(instructions).toContain(service);
      }
      for (const faq of TRADE_TEMPLATES[trade].defaultFaqs)
        expect(instructions).toContain(faq.answer);
    },
  );
});

describe("evalAgents", () => {
  it("builds each trade's agent once, with the extraction told the same business", () => {
    const agentFor = evalAgents();
    const roofer = agentFor({ trade: "roofer" });
    expect(agentFor({ trade: "roofer" })).toBe(roofer);
    expect(roofer.definition.opening).toContain("Test Roofing");
    expect(roofer.context).toEqual({ businessName: "Test Roofing", tradespersonName: "Kit" });
    expect(agentFor({ trade: DEMO_TRADE }).definition.opening).toContain("Ant's Plumbing");
  });
});
