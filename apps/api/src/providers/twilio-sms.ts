// Twilio's Messages API, over fetch like the telephony adapter, so it's testable offline.
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
}

interface MessageJson {
  sid: string;
  num_segments: string | null;
}

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
      body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
    });
    if (!response.ok) {
      throw new TwilioApiError(response.status, path, (await response.text()).slice(0, 300));
    }
    const message = (await response.json()) as MessageJson;
    const segments = Number(message.num_segments);
    return { providerRef: message.sid, segments: Number.isFinite(segments) ? segments : null };
  }
}
