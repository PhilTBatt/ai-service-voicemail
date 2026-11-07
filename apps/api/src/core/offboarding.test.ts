import { MOBILE_NETWORK_KEYS, voicemailRestoreCode } from "@callmate/shared";
import { describe, expect, it } from "vitest";
import { cancellationEmail, cancellationText, releaseDueAt } from "./offboarding.ts";
import { isGsm7, smsEncoding } from "./sms.ts";

describe("releaseDueAt", () => {
  it("is 30 UK days after the cancellation", () => {
    expect(releaseDueAt(new Date("2026-11-07T10:00:00Z")).toISOString()).toBe(
      "2026-12-07T10:00:00.000Z",
    );
  });

  it("keeps the UK time of day across a clock change", () => {
    // 11:00 BST on 1 October is 10:00 UTC; 30 days later it's 11:00 GMT, which is 11:00 UTC.
    expect(releaseDueAt(new Date("2026-10-01T10:00:00Z")).toISOString()).toBe(
      "2026-10-31T11:00:00.000Z",
    );
  });
});

describe("the cancellation notices", () => {
  const notice = (network: Parameters<typeof voicemailRestoreCode>[0]) => ({
    businessName: "Fern Lane Plumbing",
    network,
    restoreCode: voicemailRestoreCode(network),
  });

  it("give the turn-off codes and each network's voicemail restore code, where we know it", () => {
    expect(cancellationText(notice("o2"))).toContain("dial ##61#, ##67#, ##62# on your mobile");
    expect(cancellationText(notice("o2"))).toContain(
      "Then dial **61*901# to get your voicemail back.",
    );
    expect(cancellationText(notice("vodafone"))).toContain("dial **61*121*11*30#");
    expect(cancellationText(notice("ee"))).toContain("dial **61*+447953222222*11*30#");
    expect(cancellationText(notice("three"))).toContain(
      "Then ask Three to turn your voicemail back on.",
    );
    expect(cancellationText(notice(null))).toContain(
      "Then ask your network to turn your voicemail back on.",
    );
    expect(cancellationText(notice("other"))).toContain("ask your network");
  });

  it("fit in GSM-7 text, in at most three segments, for every network", () => {
    for (const network of [...MOBILE_NETWORK_KEYS, null]) {
      const text = cancellationText(notice(network));
      expect(isGsm7(text), String(network)).toBe(true);
      expect(smsEncoding(text).segments, String(network)).toBeLessThanOrEqual(3);
    }
  });

  it("email the same steps and what happens to the data, with the name made safe for HTML", () => {
    const email = cancellationEmail({ ...notice("o2"), businessName: "Smith & Sons <Plumbing>" });
    expect(email.subject).toBe("Your AnswerMate service has been cancelled");
    expect(email.text).toContain("AnswerMate for Smith & Sons <Plumbing> has been cancelled.");
    expect(email.html).toContain("Smith &amp; Sons &lt;Plumbing&gt;");
    expect(email.text).toContain("##61#, ##67#, ##62#");
    expect(email.text).toContain("**61*901#");
    expect(email.text).toContain(
      "delete your calls, recordings and details, and email you to confirm",
    );
  });
});
