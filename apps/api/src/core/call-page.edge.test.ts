// The call page behind every text's link, given what a hostile caller (or a confused LLM) could
// put in a call: a page with no login that shows caller text must never run any of it.
import { describe, expect, it } from "vitest";
import { presentCall, type CallRow } from "../routes/call-view.ts";
import { CALL_PAGE_CSP, callPageHtml, callPageMessageHtml, spokenDuration } from "./call-page.ts";

function row(overrides: Partial<CallRow> = {}): CallRow {
  return {
    id: "0b6f2b3c-9d1e-4a7f-8c2d-1e3f4a5b6c7d",
    provider_call_id: "call_edge_1",
    started_at: new Date("2026-07-15T10:00:00Z"),
    ended_at: new Date("2026-07-15T10:02:05Z"),
    billable_seconds: 125,
    caller_number: "+447700900123",
    urgency: "routine",
    summary: "Tap dripping.",
    flags: [],
    extracted_fields: { callerName: "Sam", callbackNumber: "+447700900123", postcode: "XQ12 3JL" },
    transcript: "agent: Hello.\ncaller: Hi.",
    recording_ref: "rec_1",
    via_fallback: false,
    handled_at: null,
    ...overrides,
  };
}

const page = (overrides: Partial<CallRow> = {}, handledUrl?: string) =>
  callPageHtml(
    presentCall(row(overrides), "/c/token/recording", { voice: {} as never }),
    handledUrl === undefined ? {} : { handledUrl },
  );

/** Tags a browser would act on. The page itself uses none of these. */
const ACTIVE = /<\s*(script|img|iframe|svg|object|embed|link|base|style)\b/i;

const PAYLOADS = [
  "<script>alert(document.cookie)</script>",
  '"><img src=x onerror=alert(1)>',
  "'><svg onload=alert(1)>",
  "</p></main><iframe src=//evil.example.com>",
  "<base href=//evil.example.com/>",
  "javascript:alert(1)",
  "<style>body{display:none}</style>",
];

describe("callPageHtml with hostile caller text", () => {
  it.each(PAYLOADS)("shows %j as text everywhere it can appear", (payload) => {
    const html = page({
      summary: payload,
      flags: [payload],
      transcript: `caller: ${payload}\nagent: ${payload}`,
      extracted_fields: { callerName: payload, postcode: payload, callbackNumber: null },
    });
    // The page's own <style> is the only one; nothing from the call becomes a tag.
    const withoutOwnStyle = html.replace(/<style>[\s\S]*?<\/style>/, "");
    expect(withoutOwnStyle).not.toMatch(ACTIVE);
    if (payload.includes("<")) expect(html).not.toContain(payload);
  });

  it("keeps a number with a quote in it inside its tel: link", () => {
    const html = page({
      extracted_fields: { callbackNumber: '+447700900123" onclick="alert(1)' },
    });
    expect(html).not.toContain('" onclick="');
    expect(html).toContain("&quot; onclick=&quot;");
  });

  it("escapes the form's address too", () => {
    const html = page({}, '/c/x"><script>alert(1)</script>/handled');
    expect(html).not.toContain("<script>");
  });

  it.each(["__proto__", "constructor", "toString", "<b>emergency</b>", "EMERGENCY", ""])(
    "labels an urgency it doesn't know (%j) as a plain call",
    (urgency) => {
      const html = page({ urgency });
      expect(html).toContain('<span class="badge ">Call</span>');
      expect(html).not.toContain("<b>");
    },
  );

  it("marks only emergency and urgent calls in colour", () => {
    expect(page({ urgency: "emergency" })).toContain(
      '<span class="badge emergency">EMERGENCY</span>',
    );
    expect(page({ urgency: "urgent" })).toContain('<span class="badge urgent">URGENT</span>');
    expect(page({ urgency: "spam" })).toContain('<span class="badge ">Possible spam</span>');
  });

  it("contains no script at all, and the policy allows none", () => {
    const html = page();
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son[a-z]+=/i); // no inline event handlers
    expect(CALL_PAGE_CSP).toContain("default-src 'none'");
    expect(CALL_PAGE_CSP).not.toContain("script-src");
    expect(CALL_PAGE_CSP).toContain("frame-ancestors 'none'");
    expect(CALL_PAGE_CSP).toContain("base-uri 'none'");
  });

  it("keeps itself out of search engines", () => {
    expect(page()).toContain('<meta name="robots" content="noindex, nofollow">');
  });
});

describe("callPageHtml with missing parts", () => {
  it("says the number was withheld when there is none at all, with no tel: link", () => {
    const html = page({ caller_number: null, extracted_fields: {} });
    expect(html).toContain("<p>Their number was withheld.</p>");
    expect(html).not.toContain("tel:");
    expect(html).toContain("<h1>Unknown caller</h1>");
    expect(html).toContain("<dd>Not given</dd>");
  });

  it("falls back to the caller ID when the extraction found no number", () => {
    const html = page({ extracted_fields: { callerName: "Sam" } });
    expect(html).toContain('<a class="button" href="tel:+447700900123">Call back 07700 900123</a>');
    expect(html).not.toContain("Rang from");
  });

  it("shows the caller ID as well when the caller gave another number", () => {
    const html = page({
      extracted_fields: { callbackNumber: "+447700900456" },
    });
    expect(html).toContain('href="tel:+447700900456"');
    expect(html).toContain(
      '<dt>Rang from</dt><dd><a href="tel:+447700900123">07700 900123</a></dd>',
    );
  });

  it("ignores extracted fields of the wrong type rather than printing them", () => {
    const html = page({
      extracted_fields: { callerName: 42, callbackNumber: { x: 1 }, postcode: ["XQ1"] },
    });
    expect(html).toContain("<h1>Unknown caller</h1>");
    expect(html).toContain('href="tel:+447700900123"'); // the caller ID, not [object Object]
    expect(html).not.toContain("[object Object]");
    expect(html).toContain("<dd>Not given</dd>");
  });

  it("explains a voicemail with no summary and an agent call not yet summarised", () => {
    expect(page({ via_fallback: true, summary: null, transcript: null })).toContain(
      "A voicemail: listen to it below.",
    );
    expect(page({ summary: null })).toContain("No summary yet.");
  });

  it("says when there's no transcript, cleared or empty", () => {
    expect(page({ transcript: null })).toContain("No transcript for this call.");
  });

  it("offers no player when the recording's source isn't configured", () => {
    const html = callPageHtml(presentCall(row(), "/c/token/recording", {}));
    expect(html).not.toContain("<audio");
  });

  it("shows a voicemail's length from the recording, not the (zero) billed seconds", () => {
    const html = page({
      via_fallback: true,
      billable_seconds: 0,
      extracted_fields: { recordingSeconds: 42 },
    });
    expect(html).toContain("42 sec · voicemail");
  });
});

// Phil's decision (2026-11-11): the pipeline's own flags are for the admin's review queue. On
// this page they showed the tradesperson "guardrail:price" and "judge:failed" as badges.
describe("callPageHtml and the call's flags", () => {
  it("shows the summary's notes as plain badges and none of the pipeline's own", () => {
    const html = page({
      flags: [
        "mentioned gas smell",
        "guardrail:price",
        "guardrail:safety",
        "judge:failed",
        "extraction_failed",
        "caller abusive",
      ],
    });
    expect(html).toContain(
      '<span class="badge ">New enquiry</span><span class="badge">mentioned gas smell</span><span class="badge">caller abusive</span></p>',
    );
    for (const internal of ["guardrail:", "judge:", "extraction_failed"]) {
      expect(html).not.toContain(internal);
    }
  });

  it("shows no flag badges at all when the pipeline's are the only ones", () => {
    expect(page({ flags: ["guardrail:commitment", "extraction_failed"] })).toContain(
      '<p><span class="badge ">New enquiry</span></p>',
    );
  });
});

describe("the called-back form", () => {
  it("posts handled=true while the call is open", () => {
    const html = page({}, "/c/token/handled");
    expect(html).toContain(
      '<form method="post" action="/c/token/handled"><input type="hidden" name="handled" value="true">',
    );
  });

  it("shows when it was called back, in UK time, and offers to reopen it", () => {
    const html = page({ handled_at: new Date("2026-10-25T01:30:00Z") }, "/c/token/handled");
    expect(html).toContain("Called back Sunday 25 October 2026, 01:30");
    expect(html).toContain('name="handled" value="false"');
  });

  it("isn't there at all without an address to post to", () => {
    expect(page()).not.toContain("<form");
  });
});

describe("spokenDuration", () => {
  it.each([
    [0, "0 sec"],
    [-5, "0 sec"],
    [0.4, "0 sec"],
    [59, "59 sec"],
    [59.5, "1 min"],
    [60, "1 min"],
    [61, "1 min 1 sec"],
    [125, "2 min 5 sec"],
    [3600, "60 min"],
  ])("says %d seconds as %j", (seconds, words) => {
    expect(spokenDuration(seconds)).toBe(words);
  });
});

describe("callPageMessageHtml", () => {
  it.each(["expired", "not-found", "error"] as const)(
    "escapes the dashboard address on the %s page",
    (kind) => {
      const html = callPageMessageHtml(kind, 'https://app.example.com/"><script>alert(1)</script>');
      expect(html).not.toContain("<script>");
      expect(html).toContain("&quot;&gt;&lt;script&gt;");
    },
  );

  it("leaves the button out when there's no dashboard address", () => {
    expect(callPageMessageHtml("expired")).not.toContain('class="button"');
  });
});
