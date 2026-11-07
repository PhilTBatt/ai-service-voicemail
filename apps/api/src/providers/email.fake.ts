import { randomUUID } from "node:crypto";
import type { EmailMessage, EmailProvider, EmailReceipt } from "./email.ts";

/** An in-memory EmailProvider for tests: records every send, and can be told to fail. */
export class FakeEmailProvider implements EmailProvider {
  readonly sent: (EmailMessage & EmailReceipt)[] = [];
  private failures: string[] = [];

  /** The next send rejects with this message. */
  willFail(message: string) {
    this.failures.push(message);
    return this;
  }

  send(message: EmailMessage): Promise<EmailReceipt> {
    const failure = this.failures.shift();
    if (failure !== undefined) return Promise.reject(new Error(failure));
    const receipt = { providerRef: `email_fake_${randomUUID()}` };
    this.sent.push({ ...message, ...receipt });
    return Promise.resolve(receipt);
  }
}
