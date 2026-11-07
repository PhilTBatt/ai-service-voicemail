// Tenant lifecycle statuses (BUILD_PLAN Step 1). A const tuple rather than an
// enum: enums aren't erasable syntax, so Node's type stripping can't run them.
export const TENANT_STATUSES = [
  "onboarding",
  "live",
  "paused",
  "suspended",
  "cancelling",
  "cancelled",
  "demo",
] as const;

export type TenantStatus = (typeof TENANT_STATUSES)[number];

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

export * from "./views.ts";
