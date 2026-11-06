import type { TradeTemplate } from "./template.ts";

export const electrician: TradeTemplate = {
  trade: "electrician",
  description: "an electrical business",
  defaultServices: [
    "fault finding and repairs",
    "rewires and consumer units",
    "lighting, sockets and switches",
    "electric vehicle chargers",
    "electrical safety certificates",
  ],
  emergencyKeywords: [
    "sparks",
    "burning smell",
    "smoke",
    "power cut",
    "keeps tripping",
    "exposed wires",
    "electric shock",
  ],
  questions: [
    "Has the power gone off completely, or is it just one circuit or room?",
    "Is anything hot, smoking or smelling of burning right now?",
  ],
  defaultFaqs: [
    {
      question: "Are you registered with a scheme like NICEIC or NAPIT?",
      answer: "The tradesperson will confirm their registration details when they call back.",
    },
    {
      question: "Do you do landlord safety certificates?",
      answer:
        "Electrical safety certificates are one of the services. The tradesperson will go through what's needed when they call back.",
    },
  ],
};
