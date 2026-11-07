// The login provider seam (BUILD_PLAN Step 10, decision 012). The dashboard sends a bearer
// token with every request; the provider says who it belongs to. That is the whole contract.
// Roles, tenant membership and what each role may see live in our own tables and middleware,
// so the provider (Clerk, Entra, or a self-hosted library) can change without touching them.

/** Who the provider says is calling. */
export interface Identity {
  /** The provider's stable ID for the person. Stored as users.auth_subject. */
  subject: string;
  email: string;
}

export interface AuthProvider {
  /** The identity behind a bearer token, or null when the token is missing, forged or expired. */
  verifyToken(token: string): Promise<Identity | null>;
}
