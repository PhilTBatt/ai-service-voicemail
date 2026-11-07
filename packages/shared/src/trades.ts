// The trades CallMate has templates for (BUILD_PLAN Step 3).
export const TRADES = [
  "plumber",
  "electrician",
  "heating_engineer",
  "roofer",
  "locksmith",
  "general_builder",
] as const;

export type Trade = (typeof TRADES)[number];
