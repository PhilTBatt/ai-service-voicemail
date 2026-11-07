// The Clerk adapter for the login seam (decision 012). Docs read 2026-11-08:
//   https://clerk.com/docs/reference/backend/verify-token
//   https://clerk.com/docs/reference/backend/user/get-user
//   https://clerk.com/docs/guides/sessions/session-tokens
//
// A session token is a short-lived JWT signed by Clerk. verifyToken() checks its signature
// against Clerk's public keys, which the SDK fetches once with the secret key and caches, so an
// ordinary request makes no call to Clerk. The token's `sub` claim is the person's Clerk user
// ID. Their email isn't in the token, so a first login asks Clerk for it, once, to match the
// invitation; after that the user ID alone finds the account.
import { createClerkClient, verifyToken } from "@clerk/backend";
import { TokenVerificationError, TokenVerificationErrorReason } from "@clerk/backend/errors";
import { logger } from "../logger.ts";
import type { AuthProvider, Identity } from "./auth.ts";

export interface ClerkAuthOptions {
  secretKey: string;
  /**
   * The sites the dashboard is served from. Clerk records the site a token was made for (its
   * `azp` claim), and a token made for any other site is refused.
   */
  authorizedParties: string[];
}

/** The parts of a Clerk user this adapter reads. */
export interface ClerkUserEmails {
  primaryEmailAddressId: string | null;
  emailAddresses: { id: string; emailAddress: string; verification: { status: string } | null }[];
}

/** The two Clerk calls the adapter makes. Tests pass stand-ins; production uses the SDK. */
export interface ClerkCalls {
  verify(token: string): Promise<{ sub?: unknown }>;
  getUser(userId: string): Promise<ClerkUserEmails>;
}

/**
 * Failures that mean Clerk can't be reached or our key is wrong, not that the token is bad.
 * They're raised as errors (a 500) rather than "not logged in" (a 401): a 401 would send every
 * user back to the sign-in page during a Clerk outage, in a loop.
 */
const PROVIDER_FAILURES = new Set<string>([
  TokenVerificationErrorReason.RemoteJWKFailedToLoad,
  TokenVerificationErrorReason.RemoteJWKInvalid,
  TokenVerificationErrorReason.InvalidSecretKey,
  TokenVerificationErrorReason.JWKFailedToResolve,
  TokenVerificationErrorReason.LocalJWKMissing,
]);

export class ClerkAuthProvider implements AuthProvider {
  private readonly calls: ClerkCalls;

  constructor(options: ClerkAuthOptions, calls?: ClerkCalls) {
    if (calls) {
      this.calls = calls;
      return;
    }
    const client = createClerkClient({ secretKey: options.secretKey });
    this.calls = {
      verify: (token) =>
        verifyToken(token, {
          secretKey: options.secretKey,
          authorizedParties: options.authorizedParties,
        }),
      getUser: (userId) => client.users.getUser(userId),
    };
  }

  async verifyToken(token: string): Promise<Identity | null> {
    let claims: { sub?: unknown };
    try {
      claims = await this.calls.verify(token);
    } catch (error) {
      if (error instanceof TokenVerificationError && !PROVIDER_FAILURES.has(error.reason)) {
        // Expired, forged, or made for another site. The reason is a fixed code, never the token.
        logger.info("Login token refused", { reason: error.reason });
        return null;
      }
      throw error;
    }
    return typeof claims.sub === "string" && claims.sub !== "" ? { subject: claims.sub } : null;
  }

  async verifiedEmail(subject: string): Promise<string | null> {
    const user = await this.calls.getUser(subject);
    const primary = user.emailAddresses.find(
      (address) => address.id === user.primaryEmailAddressId,
    );
    return primary?.verification?.status === "verified" ? primary.emailAddress : null;
  }
}
