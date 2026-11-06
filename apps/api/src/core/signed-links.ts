// Signed call links (BUILD_PLAN Step 6). The SMS and email carry a link to the call page;
// the token is an HMAC over the call ID and an expiry, so it can't be guessed, altered or
// used after 7 days. The API checks it and streams the recording itself, so provider URLs
// are never exposed. A 128-bit (truncated) HMAC-SHA256 keeps the token short enough for
// an SMS; it is still far beyond brute force.
import { createHmac, timingSafeEqual } from "node:crypto";

export const CALL_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^([0-9a-f]{32})\.([0-9a-z]{1,8})\.([A-Za-z0-9_-]{22})$/;

function mac(payload: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(payload)
    .digest()
    .subarray(0, 16)
    .toString("base64url");
}

export function signCallLink(
  { callId, expiresAt }: { callId: string; expiresAt: Date },
  secret: string,
): string {
  if (!UUID.test(callId)) throw new Error("callId must be a UUID");
  const payload = `${callId.replace(/-/g, "").toLowerCase()}.${Math.floor(expiresAt.getTime() / 1000).toString(36)}`;
  return `${payload}.${mac(payload, secret)}`;
}

export type CallLinkCheck =
  { ok: true; callId: string } | { ok: false; reason: "malformed" | "tampered" | "expired" };

export function verifyCallLink(token: string, secret: string, now = new Date()): CallLinkCheck {
  const match = TOKEN.exec(token);
  if (!match) return { ok: false, reason: "malformed" };
  const [, hex, exp, signature] = match as unknown as [string, string, string, string];
  const expected = Buffer.from(mac(`${hex}.${exp}`, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: "tampered" };
  }
  if (parseInt(exp, 36) * 1000 <= now.getTime()) return { ok: false, reason: "expired" };
  const callId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { ok: true, callId };
}

/** The page the tradesperson opens from a text or email. */
export function callPageUrl(publicBaseUrl: string, token: string): string {
  return `${publicBaseUrl.replace(/\/$/, "")}/c/${token}`;
}
