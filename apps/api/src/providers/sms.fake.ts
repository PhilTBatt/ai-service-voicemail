import { randomUUID } from "node:crypto";
import { smsEncoding } from "../core/sms.ts";
import type { SmsMessage, SmsProvider, SmsReceipt } from "./sms.ts";

/** An in-memory SmsProvider for tests: records every send, and can be told to fail. */
export class FakeSmsProvider implements SmsProvider {
  readonly sent: (SmsMessage & SmsReceipt)[] = [];
  private failures: (string | Error)[] = [];

  /** The next send rejects with this message, or with this error (one with a `status`, say). */
  willFail(failure: string | Error) {
    this.failures.push(failure);
    return this;
  }

  send(message: SmsMessage): Promise<SmsReceipt> {
    const failure = this.failures.shift();
    if (failure !== undefined) {
      return Promise.reject(typeof failure === "string" ? new Error(failure) : failure);
    }
    const receipt = {
      providerRef: `SMfake${randomUUID().replace(/-/g, "")}`,
      segments: smsEncoding(message.body).segments,
    };
    this.sent.push({ ...message, ...receipt });
    return Promise.resolve(receipt);
  }

  readonly deletedMessages: string[] = [];

  deleteMessage(providerRef: string): Promise<void> {
    this.deletedMessages.push(providerRef);
    return Promise.resolve();
  }
}
