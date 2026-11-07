import { randomUUID } from "node:crypto";
import type { AuthProvider, Identity } from "./auth.ts";

/** An in-memory AuthProvider for tests: hands out tokens and recognises only those. */
export class FakeAuthProvider implements AuthProvider {
  /** token → subject */
  private readonly tokens = new Map<string, string>();
  /** subject → the email the provider has verified, or null for an unverified one */
  private readonly emails = new Map<string, string | null>();

  /** A fresh token for this person. Pass `email: null` for someone whose email isn't verified. */
  tokenFor(person: { subject: string; email: string | null }): string {
    const token = `fake_${randomUUID()}`;
    this.tokens.set(token, person.subject);
    this.emails.set(person.subject, person.email);
    return token;
  }

  /** Makes a token stop working, as a sign-out or expiry would. */
  revoke(token: string): void {
    this.tokens.delete(token);
  }

  verifyToken(token: string): Promise<Identity | null> {
    const subject = this.tokens.get(token);
    return Promise.resolve(subject === undefined ? null : { subject });
  }

  verifiedEmail(subject: string): Promise<string | null> {
    return Promise.resolve(this.emails.get(subject) ?? null);
  }
}
