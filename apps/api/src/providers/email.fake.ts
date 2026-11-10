import { randomUUID } from "node:crypto";
import type { EmailMessage, EmailProvider, EmailReceipt } from "./email.ts";

/** An in-memory EmailProvider for tests: records every send, and can be told to fail. */
export class FakeEmailProvider implements EmailProvider {
  readonly sent: (EmailMessage & EmailReceipt)[] = [];
  private failures: (string | Error)[] = [];

  /** The next send rejects with this message, or with this error (one with a `status`, say). */
  willFail(failure: string | Error) {
    this.failures.push(failure);
    return this;
  }

  send(message: EmailMessage): Promise<EmailReceipt> {
    const failure = this.failures.shift();
    if (failure !== undefined) {
      return Promise.reject(typeof failure === "string" ? new Error(failure) : failure);
    }
    const receipt = { providerRef: `email_fake_${randomUUID()}` };
    this.sent.push({ ...message, ...receipt });
    return Promise.resolve(receipt);
  }
}
