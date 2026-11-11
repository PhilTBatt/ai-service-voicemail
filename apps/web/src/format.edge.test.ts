// How values read on screen, at their edges: money at the extremes, numbers as people really
// paste them, odd names, and every status and urgency the API can send having proper words.
import { TENANT_STATUSES, ukMobileSchema, URGENCIES } from "@callmate/shared";
import { describe, expect, it } from "vitest";
import {
  billingSummary,
  CHARGE_STATUS_LABELS,
  chargeTone,
  formatDuration,
  formatDurationWords,
  formatPence,
  humanise,
  initialsOf,
  statusDisplay,
  toUkMobileE164,
  urgencyLabel,
  urgencyTone,
  URGENCY_LABELS,
} from "./format.ts";

// Characters that can't be seen in an editor, so they're spelt out by number.
const NBSP = String.fromCodePoint(0xa0); // non-breaking space
const EN_DASH = String.fromCodePoint(0x2013);
const LRE = String.fromCodePoint(0x202a); // left-to-right embedding, opens an iPhone's paste
const PDF = String.fromCodePoint(0x202c); // pop directional formatting, closes it
const LRM = String.fromCodePoint(0x200e); // left-to-right mark
const BOM = String.fromCodePoint(0xfeff); // byte-order mark
/** "07700900123" in full-width digits, as some Asian keyboards type them. */
const FULL_WIDTH = String.fromCodePoint(
  ..."07700900123".split("").map((digit) => 0xff10 + Number(digit)),
);

describe("formatPence", () => {
  it("gets the pence right either side of each pound", () => {
    expect(formatPence(1)).toBe("£0.01");
    expect(formatPence(99)).toBe("£0.99");
    expect(formatPence(100)).toBe("£1.00");
    expect(formatPence(101)).toBe("£1.01");
    expect(formatPence(1_000_00)).toBe("£1000.00");
  });

  it("shows a refund's minus before the pound sign, and never a minus zero", () => {
    expect(formatPence(-1)).toBe("-£0.01");
    expect(formatPence(-0)).toBe("£0.00");
  });

  it("stays exact at the largest whole number JavaScript holds", () => {
    expect(formatPence(Number.MAX_SAFE_INTEGER)).toBe("£90071992547409.91");
  });
});

describe("call lengths", () => {
  it("rounds to the nearest second, half up", () => {
    expect(formatDuration(59.4)).toBe("0:59");
    expect(formatDuration(59.5)).toBe("1:00");
    expect(formatDurationWords(59.5)).toBe("1 min");
  });

  it("keeps counting minutes past the hour rather than wrapping", () => {
    expect(formatDuration(3600)).toBe("60:00");
    expect(formatDuration(3661)).toBe("61:01");
    expect(formatDurationWords(3661)).toBe("61 min 1 sec");
  });

  it("never goes below nothing", () => {
    expect(formatDuration(-0.4)).toBe("0:00");
    expect(formatDurationWords(0)).toBe("0 sec");
    expect(formatDurationWords(61)).toBe("1 min 1 sec");
  });
});

describe("toUkMobileE164", () => {
  it.each([
    "07700 900123",
    "07700-900-123",
    "07700.900.123",
    "(07700) 900123",
    `07700${NBSP}900123`, // a non-breaking space
    `07700${EN_DASH}900${EN_DASH}123`, // en dashes, as a word processor makes them
    "  07700900123\n",
    "\t+44 7700 900123",
    "+44 (0)7700 900123",
    "+44(0)7700900123",
    "0044 (0) 7700 900123",
    "4407700900123",
    `${LRE}+44 7700 900123${PDF}`, // an iPhone's contact, copied
    `${LRM}07700 900123`, // a left-to-right mark from a web page
    `${BOM}07700900123`, // a byte-order mark from a spreadsheet
  ])("reads %j as a UK mobile the API accepts", (typed) => {
    const stored = toUkMobileE164(typed);
    expect(stored).toBe("+447700900123");
    expect(ukMobileSchema.safeParse(stored).success).toBe(true);
  });

  it.each([
    ["", ""],
    ["0113 496 0000", "01134960000"], // a landline
    ["+44 113 496 0000", "+441134960000"],
    ["07700 90012", "0770090012"], // a digit short
    ["07700 9001234", "077009001234"], // a digit long
    ["0447700900123", "0447700900123"], // a stray 0 in front
    ["+353 86 123 4567", "+353861234567"], // Irish
    ["07700 900123 ext 2", "07700900123ext2"],
    [FULL_WIDTH, FULL_WIDTH], // full-width digits
  ])("leaves %j for the schema to refuse", (typed, compact) => {
    expect(toUkMobileE164(typed)).toBe(compact);
    expect(ukMobileSchema.safeParse(toUkMobileE164(typed)).success).toBe(false);
  });
});

describe("humanise", () => {
  it("copes with empty, short, accented and doubled-up values", () => {
    expect(humanise("")).toBe("");
    expect(humanise("a")).toBe("A");
    expect(humanise("élan_vital")).toBe("Élan vital");
    expect(humanise("under__score")).toBe("Under  score");
    expect(humanise("Already done")).toBe("Already done");
  });
});

describe("initialsOf", () => {
  it.each([
    ["", "?"],
    ["   ", "?"],
    [undefined, "?"],
    ["O'Brien Plumbing", "OP"],
    ["J. R. Jones", "JR"],
    ["anne-marie smith", "AS"],
    ["24 7 Plumbing", "27"],
    ["🔧 Fix It", "FI"],
    ["Fern Lane Plumbing and Heating", "FL"],
    ["山田 太郎", "山太"],
  ])("makes %j into %j", (name, initials) => {
    expect(initialsOf(name)).toBe(initials);
  });
});

describe("every value the API sends has words of its own", () => {
  it("labels every urgency without falling back to the stored name", () => {
    for (const urgency of URGENCIES) {
      expect(URGENCY_LABELS[urgency], urgency).toBeDefined();
      expect(urgencyLabel(urgency)).toBe(URGENCY_LABELS[urgency]);
    }
    // Something newer than this page still reads as words.
    expect(urgencyLabel("very_urgent")).toBe("Very urgent");
    expect(urgencyTone("very_urgent")).toBe("neutral");
  });

  it("names every business status in an owner's words, with a colour", () => {
    // A status added to TENANT_STATUSES fails here until it's given words and a colour.
    const expected: Record<string, ReturnType<typeof statusDisplay>> = {
      onboarding: { label: "Setting up", tone: "info" },
      live: { label: "Answering", tone: "success" },
      paused: { label: "Switched off", tone: "warning" },
      suspended: { label: "Suspended", tone: "danger" },
      cancelling: { label: "Leaving", tone: "warning" },
      cancelled: { label: "Left", tone: "neutral" },
      demo: { label: "Demo line", tone: "brand" },
    };
    expect(Object.keys(expected).sort()).toEqual([...TENANT_STATUSES].sort());
    for (const status of TENANT_STATUSES) {
      expect(statusDisplay(status), status).toEqual(expected[status]);
    }
  });

  it("names every charge status in the database's list, and colours only trouble red", () => {
    // apps/api/src/db/migrations/20261110160000_add_billing_charges.sql
    const statuses = [
      "nothing_due",
      "below_minimum",
      "no_mandate",
      "collecting",
      "pending",
      "submitted",
      "confirmed",
      "paid_out",
      "failed",
      "cancelled",
      "charged_back",
    ];
    expect(Object.keys(CHARGE_STATUS_LABELS).sort()).toEqual([...statuses].sort());
    const red = statuses.filter((status) => chargeTone(status) === "danger");
    expect(red.sort()).toEqual(["cancelled", "charged_back", "failed"]);
    expect(chargeTone("something_new")).toBe("neutral");
  });

  it("passes an unknown last charge through in the billing summary rather than dropping it", () => {
    expect(billingSummary({ isPilot: true, directDebit: "pending", lastCharge: "mystery" })).toBe(
      "Pilot · Direct Debit started · last month: mystery",
    );
  });
});
