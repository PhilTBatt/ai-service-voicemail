// Twilio's Messages API, over fetch like the telephony adapter, so it's testable offline.
import { z } from "zod";
import type { SmsMessage, SmsProvider, SmsReceipt } from "./sms.ts";
import { TwilioApiError } from "./twilio.ts";

export interface TwilioSmsOptions {
  accountSid: string;
  authToken: string;
  /**
   * The shared notification number (E.164 UK mobile: UK local numbers can't send SMS), or
   * an alphanumeric sender ID of up to 11 characters, which can't receive replies.
   */
  from: string;
  /** Injected by tests. */
  fetch?: typeof fetch;
  /** Must finish well inside the job's 60-second expiry, or pg-boss re-queues a job that's still sending. */
  timeoutMs?: number;
  /** Where Twilio posts delivery receipts (signed like every webhook). */
  statusCallbackUrl?: string;
}

/** What a created message's answer needs, checked (CLAUDE.md: every outside input). */
const messageSchema = z.object({
  sid: z.string().min(1),
  num_segments: z.union([z.string(), z.number()]).nullable().optional(),
});

export class TwilioSmsProvider implements SmsProvider {
  private readonly options: TwilioSmsOptions;

  constructor(options: TwilioSmsOptions) {
    this.options = options;
  }

  async send({ to, body }: SmsMessage): Promise<SmsReceipt> {
    const { accountSid, authToken, from } = this.options;
    const path = `/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;
    const response = await (this.options.fetch ?? fetch)(`https://api.twilio.com${path}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        To: to,
        From: from,
        Body: body,
        ...(this.options.statusCallbackUrl !== undefined && {
          StatusCallback: this.options.statusCallbackUrl,
        }),
      }).toString(),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
    });
    if (!response.ok) {
      throw new TwilioApiError(response.status, path, (await response.text()).slice(0, 300));
    }
    const parsed = messageSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Twilio's answer to a sent text had no message ID");
    // A count of 0, or none, isn't a count: it's left to our own (a text is at least one
    // segment, and the onboarding and cancellation rows refuse 0).
    const segments = Number(parsed.data.num_segments ?? Number.NaN);
    return {
      providerRef: parsed.data.sid,
      segments: Number.isInteger(segments) && segments > 0 ? segments : null,
    };
  }

  // Twilio's docs (read 2026-11-07): DELETE /Messages/{Sid}.json deletes the message with its
  // media and answers 204, and a deleted message can't be recovered, though its body may stay
  // in Twilio's backups for up to 30 days. What a missing message returns isn't stated; a 404
  // is taken to mean it's already gone.
  async deleteMessage(providerRef: string): Promise<void> {
    const { accountSid, authToken } = this.options;
    const path = `/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages/${encodeURIComponent(providerRef)}.json`;
    const response = await (this.options.fetch ?? fetch)(`https://api.twilio.com${path}`, {
      method: "DELETE",
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
      },
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
    });
    if (response.ok || response.status === 404) return;
    throw new TwilioApiError(response.status, path, (await response.text()).slice(0, 300));
  }
}
