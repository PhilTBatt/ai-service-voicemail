// The login seam's stand-in for the browser smoke tests. The dashboard's stand-in for Clerk
// (apps/web/src/testing/clerk-stub.tsx) sends base64 JSON naming who is signed in; this reads
// it back. Only the smoke-test server (e2e-server.ts) uses it. The real server can't: it only
// ever builds the Clerk adapter.
import type { AuthProvider, Identity } from "../providers/auth.ts";

export class E2eAuthProvider implements AuthProvider {
  private readonly emails = new Map<string, string>();

  verifyToken(token: string): Promise<Identity | null> {
    try {
      const person = JSON.parse(Buffer.from(token, "base64").toString("utf8")) as unknown;
      if (
        typeof person === "object" &&
        person !== null &&
        "subject" in person &&
        "email" in person &&
        typeof person.subject === "string" &&
        typeof person.email === "string"
      ) {
        this.emails.set(person.subject, person.email);
        return Promise.resolve({ subject: person.subject });
      }
    } catch {
      // Not base64 JSON: treated like a forged token.
    }
    return Promise.resolve(null);
  }

  verifiedEmail(subject: string): Promise<string | null> {
    return Promise.resolve(this.emails.get(subject) ?? null);
  }

  /** The smoke tests never delete a business's data. */
  deleteLogin(): Promise<void> {
    return Promise.resolve();
  }
}
