import { describe, expect, it } from "vitest";
import {
  directDebitEndedEmail,
  formatDate,
  lastDayOf,
  paymentFailedEmail,
  receiptEmail,
} from "./billing-emails.ts";

const charge = {
  periodStart: "2026-10-14",
  periodEnd: "2026-11-14",
  lines: [
    { description: "AI Answering plan", pence: 9900 },
    { description: "2 minutes over the 200 included, at 20p a minute", pence: 40 },
  ],
  vatRatePercent: 0,
  vatPence: 0,
  totalPence: 9940,
  vatNumber: null,
  chargeDate: "2026-11-19",
};

describe("receiptEmail", () => {
  it("names the month, each part and the total, and when it's collected", () => {
    const email = receiptEmail("Wren & Sons Plumbing", charge);
    expect(email.subject).toBe("Your AnswerMate receipt: 14 Oct 2026 to 13 Nov 2026");
    expect(email.text).toContain(
      "Here's your AnswerMate receipt for Wren & Sons Plumbing, for 14 Oct 2026 to 13 Nov 2026.",
    );
    expect(email.text).toContain("AI Answering plan: £99.00");
    expect(email.text).toContain("2 minutes over the 200 included, at 20p a minute: £0.40");
    expect(email.text).toContain("Total: £99.40");
    expect(email.text).toContain("collected by Direct Debit on or soon after 19 Nov 2026");
    expect(email.text).toContain("No VAT is charged on this month.");
    expect(email.text).not.toContain("VAT at");
    // The business's name is escaped in the HTML.
    expect(email.html).toContain("Wren &amp; Sons Plumbing");
    expect(email.html).not.toContain("Wren & Sons");
  });

  it("adds a VAT line and the registration number once VAT is charged", () => {
    const email = receiptEmail("Wren Plumbing", {
      ...charge,
      vatRatePercent: 20,
      vatPence: 1988,
      totalPence: 11928,
      vatNumber: "GB123456789",
    });
    expect(email.text).toContain("VAT at 20%: £19.88");
    expect(email.text).toContain("Total: £119.28");
    expect(email.text).toContain("VAT registration number: GB123456789.");
  });
});

describe("the other billing emails", () => {
  it("says a payment couldn't be collected, and that calls are still answered", () => {
    const email = paymentFailedEmail("Wren Plumbing", charge);
    expect(email.subject).toBe("We couldn't collect your AnswerMate payment");
    expect(email.text).toContain("We couldn't collect £99.40 by Direct Debit");
    expect(email.text).toContain("Your assistant is still answering your calls.");
  });

  it("says a Direct Debit ended, with the link to set it up again", () => {
    const email = directDebitEndedEmail(
      "Wren Plumbing",
      "https://dash.example/tenants/t1/settings",
    );
    expect(email.text).toContain("has ended");
    expect(email.text).toContain("https://dash.example/tenants/t1/settings");
  });
});

describe("dates", () => {
  it("writes them as people do, and knows a month's last day", () => {
    expect(formatDate("2026-01-05")).toBe("5 Jan 2026");
    expect(lastDayOf("2026-03-01")).toBe("2026-02-28");
  });
});
