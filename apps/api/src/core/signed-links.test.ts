import { describe, expect, it } from "vitest";
import { CALL_LINK_TTL_MS, callPageUrl, signCallLink, verifyCallLink } from "./signed-links.ts";

const SECRET = "test-signing-secret-at-least-32-characters-long";
const CALL_ID = "0b6f2b3c-9d1e-4a7f-8c2d-1e3f4a5b6c7d";
const NOW = new Date("2026-11-06T12:00:00Z");
const token = signCallLink(
  { callId: CALL_ID, expiresAt: new Date(NOW.getTime() + CALL_LINK_TTL_MS) },
  SECRET,
);

describe("signed call links", () => {
  it("round-trips the call ID while the link is valid", () => {
    expect(verifyCallLink(token, SECRET, NOW)).toEqual({ ok: true, callId: CALL_ID });
    expect(
      verifyCallLink(token, SECRET, new Date(NOW.getTime() + CALL_LINK_TTL_MS - 1000)),
    ).toEqual({
      ok: true,
      callId: CALL_ID,
    });
  });

  it("is short enough for an SMS and stays the same for the same input", () => {
    expect(token.length).toBeLessThanOrEqual(64);
    expect(
      signCallLink(
        { callId: CALL_ID, expiresAt: new Date(NOW.getTime() + CALL_LINK_TTL_MS) },
        SECRET,
      ),
    ).toBe(token);
  });

  it("expires after 7 days", () => {
    expect(verifyCallLink(token, SECRET, new Date(NOW.getTime() + CALL_LINK_TTL_MS))).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects a token signed with another secret", () => {
    expect(verifyCallLink(token, SECRET + "x", NOW)).toEqual({ ok: false, reason: "tampered" });
  });

  it("rejects a tampered call ID, expiry or signature", () => {
    const [id, exp, sig] = token.split(".") as [string, string, string];
    const otherId = (id[0] === "0" ? "1" : "0") + id.slice(1);
    const laterExp = (parseInt(exp, 36) + 86_400 * 365).toString(36);
    const otherSig = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    for (const forged of [
      `${otherId}.${exp}.${sig}`,
      `${id}.${laterExp}.${sig}`,
      `${id}.${exp}.${otherSig}`,
    ]) {
      expect(verifyCallLink(forged, SECRET, NOW)).toEqual({ ok: false, reason: "tampered" });
    }
  });

  it.each(["", "abc", `${CALL_ID}.1.sig`, token + ".extra", token.toUpperCase()])(
    "treats %s as malformed",
    (bad) => {
      expect(verifyCallLink(bad, SECRET, NOW).ok).toBe(false);
    },
  );

  it("refuses to sign something that isn't a UUID", () => {
    expect(() => signCallLink({ callId: "1", expiresAt: NOW }, SECRET)).toThrow("UUID");
  });

  it("builds the call page URL without a double slash", () => {
    expect(callPageUrl("https://callmate.example.com/", "tok")).toBe(
      "https://callmate.example.com/c/tok",
    );
  });
});
