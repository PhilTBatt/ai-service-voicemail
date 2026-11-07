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

export * from "./trades.ts";

export * from "./views.ts";
export * from "./profile.ts";
export * from "./settings.ts";
export * from "./onboarding.ts";
export * from "./signup.ts";
export * from "./divert.ts";
export * from "./guardrail-patterns.ts";
