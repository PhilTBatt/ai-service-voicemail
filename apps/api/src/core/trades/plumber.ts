import type { TradeTemplate } from "./template.ts";

export const plumber: TradeTemplate = {
  trade: "plumber",
  description: "a plumbing business",
  defaultServices: [
    "leaks and burst pipes",
    "blocked drains, sinks and toilets",
    "taps, showers and bathrooms",
    "boilers and hot water",
    "radiators and heating",
  ],
  emergencyKeywords: [
    "burst pipe",
    "flooding",
    "water through the ceiling",
    "can't turn the water off",
    "no hot water",
    "no heating",
    "boiler leaking",
    "gas smell",
  ],
  questions: [
    "Is water still escaping, and have they managed to turn it off at the stopcock?",
    "Is it a house or a flat, and which floor is the problem on?",
  ],
  defaultFaqs: [
    {
      question: "Are you Gas Safe registered?",
      answer: "The tradesperson will confirm their registration details when they call back.",
    },
    {
      question: "Do you cover emergencies?",
      answer:
        "Urgent jobs are passed on straight away. The tradesperson will say when they can come when they call back.",
    },
  ],
};
