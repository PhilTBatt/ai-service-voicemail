// The seam between CallMate and the email provider (decision 010: Postmark recommended,
// Phil picks). The caller has already applied the outbound allowlist; the adapter only sends.

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain-text body: every email has one, for clients that can't or won't show HTML. */
  text: string;
  html: string;
}

export interface EmailReceipt {
  providerRef: string;
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<EmailReceipt>;
}
