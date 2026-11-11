// Edge cases for the signed call links (signed-links.ts): the token is the only credential for
// a page holding a caller's details, so every way of bending it must fail closed.
import { describe, expect, it } from "vitest";
import { CALL_LINK_TTL_MS, callPageUrl, signCallLink, verifyCallLink } from "./signed-links.ts";

const SECRET = "edge-test-signing-secret-at-least-32-characters";
const CALL_ID = "6c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const NOW = new Date("2026-11-11T12:00:00Z");
const EXPIRES = new Date(NOW.getTime() + CALL_LINK_TTL_MS);
const token = signCallLink({ callId: CALL_ID, expiresAt: EXPIRES }, SECRET);

describe("signCallLink", () => {
  it("signs an upper-case UUID exactly as its lower-case form, and gives back lower case", () => {
    const upper = signCallLink({ callId: CALL_ID.toUpperCase(), expiresAt: EXPIRES }, SECRET);
    expect(upper).toBe(token);
    expect(verifyCallLink(upper, SECRET, NOW)).toEqual({ ok: true, callId: CALL_ID });
  });

  it.each([
    "",
    "not-a-uuid",
    `${CALL_ID}x`,
    ` ${CALL_ID}`,
    CALL_ID.replaceAll("-", ""),
    "../../etc/passwd",
    `${CALL_ID}\n`,
  ])("refuses to sign %j", (callId) => {
    expect(() => signCallLink({ callId, expiresAt: EXPIRES }, SECRET)).toThrow(
      "callId must be a UUID",
    );
  });

  it("gives different tokens for different secrets and different expiries", () => {
    expect(signCallLink({ callId: CALL_ID, expiresAt: EXPIRES }, `${SECRET}!`)).not.toBe(token);
    expect(
      signCallLink({ callId: CALL_ID, expiresAt: new Date(EXPIRES.getTime() + 1000) }, SECRET),
    ).not.toBe(token);
  });
});

describe("verifyCallLink at the moment of expiry", () => {
  // The expiry is kept to the second (rounded down), and a link is expired from that second on.
  const expiresAt = new Date("2026-11-18T12:00:00.999Z");
  const link = signCallLink({ callId: CALL_ID, expiresAt }, SECRET);

  it.each([
    ["2026-11-18T11:59:59.999Z", true],
    ["2026-11-18T12:00:00.000Z", false],
    ["2026-11-18T12:00:00.500Z", false],
    ["2099-01-01T00:00:00.000Z", false],
  ])("at %s, valid is %s", (iso, valid) => {
    const check = verifyCallLink(link, SECRET, new Date(iso));
    expect(check).toEqual(valid ? { ok: true, callId: CALL_ID } : { ok: false, reason: "expired" });
  });

  it("refuses a link signed already expired", () => {
    const stale = signCallLink({ callId: CALL_ID, expiresAt: new Date(0) }, SECRET);
    expect(verifyCallLink(stale, SECRET, NOW)).toEqual({ ok: false, reason: "expired" });
  });

  it("checks the signature before the expiry, so a forged link learns nothing about time", () => {
    const [hex, exp] = token.split(".") as [string, string];
    const forged = `${hex}.${exp}.${"A".repeat(22)}`;
    expect(verifyCallLink(forged, SECRET, new Date("2099-01-01T00:00:00Z"))).toEqual({
      ok: false,
      reason: "tampered",
    });
  });
});

describe("verifyCallLink against tampering", () => {
  const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-";

  it("refuses the token with any single character changed", () => {
    for (let index = 0; index < token.length; index++) {
      if (token[index] === ".") continue;
      const swapped = ALPHABET[(ALPHABET.indexOf(token[index]!) + 1) % ALPHABET.length]!;
      const changed = `${token.slice(0, index)}${swapped}${token.slice(index + 1)}`;
      const check = verifyCallLink(changed, SECRET, NOW);
      expect(check.ok, `position ${index}`).toBe(false);
    }
  });

  it("refuses another call's ID under this call's signature", () => {
    const other = signCallLink(
      { callId: "7d2e3f4a-5b6c-4d7e-8f90-1a2b3c4d5e6f", expiresAt: EXPIRES },
      SECRET,
    );
    const [otherHex] = other.split(".") as [string];
    const [, exp, signature] = token.split(".") as [string, string, string];
    expect(verifyCallLink(`${otherHex}.${exp}.${signature}`, SECRET, NOW)).toEqual({
      ok: false,
      reason: "tampered",
    });
  });

  it("refuses a later expiry under the original signature", () => {
    const [hex, , signature] = token.split(".") as [string, string, string];
    const later = Math.floor(EXPIRES.getTime() / 1000 + 365 * 86_400).toString(36);
    expect(verifyCallLink(`${hex}.${later}.${signature}`, SECRET, NOW)).toEqual({
      ok: false,
      reason: "tampered",
    });
  });

  it.each([
    ["an empty string", ""],
    ["spaces round it", ` ${token} `],
    ["a trailing newline", `${token}\n`],
    ["a trailing slash", `${token}/`],
    ["URL-encoded dots", token.replaceAll(".", "%2E")],
    ["an upper-case call ID", token.replace(/^[0-9a-f]+/, (hex) => hex.toUpperCase())],
    ["a dashed UUID", token.replace(/^[0-9a-f]+/, CALL_ID)],
    ["a signature one character short", token.slice(0, -1)],
    ["a signature one character long", `${token}A`],
    ["base64 padding", `${token}==`],
    ["an expiry of nine characters", token.replace(/\.[0-9a-z]+\./, ".zzzzzzzzz.")],
    ["a huge input", "a".repeat(1_000_000)],
  ])("refuses %s as malformed", (_what, given) => {
    expect(verifyCallLink(given, SECRET, NOW)).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses a token signed with an empty secret when the real one is set", () => {
    const blank = signCallLink({ callId: CALL_ID, expiresAt: EXPIRES }, "");
    expect(verifyCallLink(blank, SECRET, NOW)).toEqual({ ok: false, reason: "tampered" });
  });
});

describe("callPageUrl", () => {
  it.each([
    ["https://callmate.example.com", `https://callmate.example.com/c/${token}`],
    ["https://callmate.example.com/", `https://callmate.example.com/c/${token}`],
    ["http://localhost:3000", `http://localhost:3000/c/${token}`],
  ])("joins %s and the token with one slash", (base, want) => {
    expect(callPageUrl(base, token)).toBe(want);
  });

  it("makes a URL that survives an SMS: nothing a phone would break the link on", () => {
    expect(callPageUrl("https://callmate.example.com", token)).toMatch(
      /^https:\/\/callmate\.example\.com\/c\/[0-9a-f]{32}\.[0-9a-z]+\.[A-Za-z0-9_-]{22}$/,
    );
  });
});
