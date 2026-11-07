import { randomUUID } from "node:crypto";
import type { AuthProvider, Identity } from "./auth.ts";

/** An in-memory AuthProvider for tests: hands out tokens and recognises only those. */
export class FakeAuthProvider implements AuthProvider {
  private readonly tokens = new Map<string, Identity>();

  /** A fresh token that verifies as this identity. */
  tokenFor(identity: Identity): string {
    const token = `fake_${randomUUID()}`;
    this.tokens.set(token, identity);
    return token;
  }

  /** Makes a token stop working, as a sign-out or expiry would. */
  revoke(token: string): void {
    this.tokens.delete(token);
  }

  verifyToken(token: string): Promise<Identity | null> {
    return Promise.resolve(this.tokens.get(token) ?? null);
  }
}
