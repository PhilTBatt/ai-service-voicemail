import type { TradeTemplate } from "./template.ts";

export const generalBuilder: TradeTemplate = {
  trade: "general_builder",
  description: "a building business",
  defaultServices: [
    "extensions and conversions",
    "renovations and refurbishments",
    "brickwork and pointing",
    "plastering and rendering",
    "kitchens and bathrooms",
    "general repairs",
  ],
  emergencyKeywords: [
    "collapse",
    "structural",
    "cracks appearing",
    "wall moving",
    "dangerous",
    "water coming in",
  ],
  questions: [
    "Is this a repair, or a bigger project like an extension?",
    "Do you already have plans or drawings?",
  ],
  defaultFaqs: [
    {
      question: "Can you give me a rough price?",
      answer: "The tradesperson will discuss costs once they've seen the job, when they call back.",
    },
    {
      question: "Do you handle planning permission?",
      answer: "The tradesperson will explain what's involved for your project when they call back.",
    },
  ],
};
