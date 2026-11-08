import type { TradeTemplate } from "./template.ts";

export const heatingEngineer: TradeTemplate = {
  trade: "heating_engineer",
  description: "a heating and gas engineering business",
  defaultServices: [
    "boiler breakdowns and repairs",
    "boiler servicing and installation",
    "central heating and radiators",
    "gas safety checks and landlord certificates",
    "hot water cylinders",
  ],
  emergencyKeywords: [
    "gas smell",
    "carbon monoxide",
    "CO alarm",
    "no heating",
    "no hot water",
    "boiler leaking",
    "boiler won't start",
    "error code",
  ],
  questions: [
    "What make is the boiler, and is it showing an error code or light?",
    "Is there any heating or hot water at all at the moment?",
  ],
  defaultFaqs: [
    {
      question: "Are you Gas Safe registered?",
      answer: "The tradesperson will confirm their registration details when they call back.",
    },
    {
      question: "How often should a boiler be serviced?",
      // Servicing is gas safety advice, which only Appendix A's scripts give: the answer defers.
      answer: "The tradesperson will advise on servicing for your boiler when they call back.",
    },
  ],
};
