// Postmark's email API (decision 010), over fetch like the other adapters so it's testable
// offline. Docs read 2026-11-07: https://postmarkapp.com/developer/api/email-api
import type { EmailMessage, EmailProvider, EmailReceipt } from "./email.ts";
import { redactText } from "../redact.ts";

export interface PostmarkOptions {
  /** The server token, from the server's "API Tokens" tab. A secret. */
  serverToken: string;
  /** Must be an address at a domain Postmark has verified (a confirmed sender signature). */
  from: string;
  /** Where replies go, if different from `from`. */
  replyTo?: string;
  /** Injected by tests. */
  fetch?: typeof fetch;
  /** Must finish well inside the job's 60-second expiry. */
  timeoutMs?: number;
}

/** A non-2xx answer from Postmark. `errorCode` is Postmark's own code (10 bad token, 300 invalid request, 406 inactive recipient...). */
export class PostmarkApiError extends Error {
  override readonly name = "PostmarkApiError";
  readonly status: number;
  readonly errorCode: number | null;

  constructor(status: number, errorCode: number | null, detail: string) {
    // The provider's own words can quote the address or number it refused. Errors are logged,
    // and stored with failed jobs in the queue's tables, so the detail is redacted here, once.
    super(
      `Postmark /email failed: HTTP ${status}, error ${errorCode ?? "?"}: ${redactText(detail)}`,
    );
    this.status = status;
    this.errorCode = errorCode;
  }
}

interface SendResponse {
  MessageID?: string;
  ErrorCode?: number;
  Message?: string;
}

export class PostmarkEmailProvider implements EmailProvider {
  private readonly options: PostmarkOptions;

  constructor(options: PostmarkOptions) {
    this.options = options;
  }

  async send({ to, subject, text, html }: EmailMessage): Promise<EmailReceipt> {
    const response = await (this.options.fetch ?? fetch)("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": this.options.serverToken,
      },
      body: JSON.stringify({
        From: this.options.from,
        To: to,
        Subject: subject,
        TextBody: text,
        HtmlBody: html,
        MessageStream: "outbound", // the default transactional stream; never the broadcast one
        ...(this.options.replyTo !== undefined && { ReplyTo: this.options.replyTo }),
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
    });
    let json: SendResponse | null = null;
    try {
      json = (await response.json()) as SendResponse;
    } catch {
      // A non-JSON body (a gateway page, say): the status is all we have.
    }
    if (!response.ok || !json?.MessageID) {
      throw new PostmarkApiError(
        response.status,
        json?.ErrorCode ?? null,
        (json?.Message ?? "no message").slice(0, 200),
      );
    }
    return { providerRef: json.MessageID };
  }
}
