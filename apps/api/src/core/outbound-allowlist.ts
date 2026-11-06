// BUILD_PLAN Step 6: outside production, SMS and email go only to addresses on the
// allowlist. Nothing in development or staging can ever text or email a real customer.
// CLAUDE.md rule 4: never remove or bypass this check.

export interface OutboundPolicy {
  nodeEnv: "development" | "test" | "production";
  /** E.164 numbers and email addresses, as configured in OUTBOUND_ALLOWLIST. */
  allowlist: ReadonlySet<string>;
}

export type OutboundDecision = { allowed: true } | { allowed: false; reason: string };

export function checkOutbound(policy: OutboundPolicy, to: string): OutboundDecision {
  if (policy.nodeEnv === "production") return { allowed: true };
  const target = to.trim().toLowerCase();
  if (policy.allowlist.has(target)) return { allowed: true };
  return {
    allowed: false,
    reason: `${policy.nodeEnv} environment: recipient not in OUTBOUND_ALLOWLIST`,
  };
}

export function parseAllowlist(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
}
