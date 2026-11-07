// The login provider seam (BUILD_PLAN Step 10, decision 012). The dashboard sends a bearer
// token with every request; the provider says who it belongs to. Roles, tenant membership and
// what each role may see live in our own tables and middleware, so the provider (Clerk today)
// can change without touching them.

/** Who the provider says is calling. */
export interface Identity {
  /** The provider's stable ID for the person. Stored as users.auth_subject. */
  subject: string;
}

export interface AuthProvider {
  /**
   * The identity behind a bearer token, or null when the token is forged, expired or meant
   * for another site. Runs on every request, so it must not call the provider each time.
   * Rejects (an error, not null) when the provider itself can't be reached or is
   * misconfigured, so an outage shows as an error instead of logging everyone out.
   */
  verifyToken(token: string): Promise<Identity | null>;
  /**
   * The person's primary email, only if the provider has verified it (magic link, code or
   * Google); otherwise null. Asked only on a first login, to match an invitation, so it may
   * make a network call. An adapter must never return an unverified address here.
   */
  verifiedEmail(subject: string): Promise<string | null>;
}
