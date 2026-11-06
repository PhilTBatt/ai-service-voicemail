import type { TradeTemplate } from "./template.ts";

export const locksmith: TradeTemplate = {
  trade: "locksmith",
  description: "a locksmith business",
  defaultServices: [
    "lockouts and lost keys",
    "lock changes and upgrades",
    "broken keys and jammed locks",
    "uPVC door and window repairs",
    "security advice and safes",
  ],
  emergencyKeywords: [
    "locked out",
    "broken into",
    "burglary",
    "can't lock the door",
    "child locked in",
    "keys stolen",
  ],
  questions: [
    "Are you locked out right now, and is anyone inside the property?",
    "What type of door and lock is it, if you know?",
  ],
  defaultFaqs: [
    {
      question: "Will I need to prove I live there?",
      answer:
        "Yes. The tradesperson will ask for ID or proof of address before opening or changing a lock.",
    },
    {
      question: "Can you come out tonight?",
      answer: "The tradesperson will say when they can come when they call back.",
    },
  ],
};
