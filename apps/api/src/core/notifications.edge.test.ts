// Edge and hostile cases for the texts and emails (notifications.ts): what the LLM or a caller
// could put in a summary, a name or a transcript, and the UK clock around its changes.
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import {
  callEmail,
  callSms,
  emergencyCallerSms,
  emergencyTradespersonSms,
  formatUkDateTime,
  voicemailEmail,
  voicemailSms,
  type CallEmailInput,
  type CallNotificationInput,
} from "./notifications.ts";
import { GAS_EMERGENCY_NUMBER } from "./scripts.ts";
import { isGsm7, smsEncoding } from "./sms.ts";
import { ukDateTime } from "./uk-time.ts";

const CALL_URL =
  "https://callmate.example.com/c/0123456789abcdef0123456789abcdef.t2x9k1.AAAAAAAAAAAAAAAAAAAAAA";

const BASE: CallNotificationInput = {
  urgency: "routine",
  callerName: "Sam",
  callbackNumber: "+447700900123",
  postcode: "XQ12 3JL",
  summary: "Tap dripping in the kitchen.",
  callUrl: CALL_URL,
};

/**
 * Runs callSms in a worker thread and gives up after `ms`. The cut-to-fit loop once went round
 * forever on some inputs; a synchronous loop can't be timed out in the test's own thread (it
 * would hang the whole run), so the inputs that caught it run where they can be stopped.
 */
function callSmsInWorker(
  inputs: CallNotificationInput[],
  ms = 8_000,
): Promise<{ body: string; segments: number }[]> {
  const moduleUrl = new URL("./notifications.ts", import.meta.url).href;
  const worker = new Worker(
    `const { parentPort, workerData } = require("node:worker_threads");
     import(workerData.moduleUrl).then(({ callSms }) => {
       parentPort.postMessage(workerData.inputs.map((input) => callSms(input)));
     }, (error) => parentPort.postMessage({ error: String(error) }));`,
    { eval: true, workerData: { moduleUrl, inputs } },
  );
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error(`callSms didn't finish within ${ms} ms: it is looping`));
    }, ms);
    worker.once("message", (result: unknown) => {
      clearTimeout(timer);
      void worker.terminate();
      if (result && typeof result === "object" && "error" in result) {
        reject(new Error(String(result.error)));
      } else {
        resolve(result as { body: string; segments: number }[]);
      }
    });
    worker.once("error", (error: unknown) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

describe("callSms on hostile input", () => {
  // Each of these used to spin forever in the cut-to-fit loop, which blocks the worker
  // process: every other tenant's texts stop with it.
  const HANGERS: [string, CallNotificationInput][] = [
    [
      "a name that fills the text, and a summary with no space in its first 20 characters",
      { ...BASE, callerName: "A".repeat(320), summary: "Boiler-leaking-under-the-sink" },
    ],
    [
      "a summary of extension characters only (two septets each, no spaces)",
      { ...BASE, summary: "€".repeat(200) },
    ],
    ["a summary of braces with no spaces", { ...BASE, summary: "{".repeat(170) }],
    [
      "a postcode that fills the text",
      { ...BASE, postcode: "X".repeat(400), summary: "No-spaces-in-this-summary-at-all" },
    ],
  ];

  it("always finishes, whatever the summary and name hold", { timeout: 20_000 }, async () => {
    const results = await callSmsInWorker(HANGERS.map(([, input]) => input));
    expect(results).toHaveLength(HANGERS.length);
    for (const [index, { body }] of results.entries()) {
      const [what] = HANGERS[index]!;
      expect(isGsm7(body), what).toBe(true);
      // The link is never what gets cut: it's the way into the call.
      expect(body.split("\n").at(-1), what).toBe(`Details: ${CALL_URL}`);
    }
  });

  it("keeps a summary-only overflow within two segments", { timeout: 20_000 }, async () => {
    const [extension, braces] = await callSmsInWorker([HANGERS[1]![1], HANGERS[2]![1]]);
    expect(extension!.segments).toBeLessThanOrEqual(2);
    expect(braces!.segments).toBeLessThanOrEqual(2);
    expect(smsEncoding(extension!.body).segments).toBe(extension!.segments);
  });

  it(
    "cuts the summary right down, with an ellipsis, when the name alone fills the text",
    { timeout: 20_000 },
    async () => {
      const [result] = await callSmsInWorker([HANGERS[0]![1]]);
      const summaryLine = result!.body.split("\n")[1]!;
      expect(summaryLine.endsWith("...")).toBe(true);
      expect(summaryLine.length).toBeLessThanOrEqual(20);
    },
  );

  it.each([
    ["one long word", "x".repeat(1000)],
    ["many short words", "word ".repeat(400)],
    ["emoji only", "\u{1F525}".repeat(300)],
    ["CJK text it can't carry", "漏水".repeat(200)],
    ["curly quotes and dashes", "“leak” — ‘now’ … ".repeat(40)],
    ["tabs and odd spaces", "leak\tunder the sink ".repeat(40)],
    ["HTML in the summary", "<script>alert(1)</script> ".repeat(30)],
  ])("fits %s into two GSM-7 segments", (_what, summary) => {
    const { body, segments } = callSms({ ...BASE, summary });
    expect(isGsm7(body)).toBe(true);
    expect(segments).toBeLessThanOrEqual(2);
    expect(smsEncoding(body).segments).toBe(segments);
    expect(body.split("\n")).toEqual([
      "New enquiry: Sam, 07700 900123, XQ12 3JL",
      expect.any(String),
      "Call back: tel:+447700900123",
      `Details: ${CALL_URL}`,
    ]);
  });

  it("never lets a newline in a field split the text into extra lines", () => {
    const { body } = callSms({ ...BASE, summary: "Line one\nLine two\nLine three\nLine four" });
    expect(body.split("\n")).toHaveLength(4);
    expect(body.split("\n")[1]).toBe("Line one Line two");
  });

  it("labels an unknown urgency (null) as a plain call", () => {
    expect(callSms({ ...BASE, urgency: null }).body.split("\n")[0]).toBe(
      "Call: Sam, 07700 900123, XQ12 3JL",
    );
  });
});

describe("the emergency texts", () => {
  it.each(["+447700900000", "+447700900999", "+441134960000"])(
    "keeps the tradesperson's priority text to one GSM-7 segment with %s",
    (number) => {
      const { body, segments } = emergencyTradespersonSms({ callbackNumber: number });
      expect(segments).toBe(1);
      expect(isGsm7(body)).toBe(true);
      expect(body).toContain(`tel:${number}`);
    },
  );

  it("says the number was withheld rather than printing a broken link", () => {
    const { body } = emergencyTradespersonSms({ callbackNumber: null });
    expect(body).toContain("Their number was withheld.");
    expect(body).not.toContain("tel:");
  });

  it.each(Object.entries(GAS_EMERGENCY_NUMBER))(
    "gives the caller the %s gas emergency number exactly, and 999, with no link",
    (region, number) => {
      const { body, segments } = emergencyCallerSms({
        businessName: "Leeds Heating \u{1F525} & Gas",
        region: region as keyof typeof GAS_EMERGENCY_NUMBER,
      });
      expect(body).toContain(` on ${number}.`);
      expect(body).toContain("Call 999.");
      expect(body).not.toMatch(/https?:/);
      expect(isGsm7(body)).toBe(true);
      expect(segments).toBeLessThanOrEqual(2);
    },
  );
});

describe("voicemailSms", () => {
  it("copes with a zero-length recording and a withheld number", () => {
    const { body } = voicemailSms({ callbackNumber: null, durationSeconds: 0, callUrl: CALL_URL });
    expect(body.split("\n")).toEqual([
      "New voicemail (0 sec) from a withheld number. The assistant wasn't available, so the caller left a message.",
      `Listen: ${CALL_URL}`,
    ]);
  });
});

describe("callEmail with hostile caller text", () => {
  const EMAIL: CallEmailInput = {
    ...BASE,
    businessName: "Leeds Plumbing",
    startedAt: new Date("2026-07-15T10:00:00Z"),
    flags: [],
    transcript: [],
    recordingUrl: null,
  };
  const PAYLOADS = [
    "<script>alert(1)</script>",
    '"><img src=x onerror=alert(1)>',
    "</p><iframe src=//evil.example.com></iframe>",
    "<svg/onload=alert(1)>",
  ];

  it.each(PAYLOADS)("escapes %j wherever caller text reaches the HTML", (payload) => {
    const { html } = callEmail({
      ...EMAIL,
      businessName: `Biz ${payload}`,
      callerName: payload,
      postcode: payload,
      summary: payload,
      flags: [payload],
      transcript: [
        { role: "caller", text: payload },
        { role: "agent", text: payload },
      ],
    });
    for (const tag of ["<script", "<img", "<iframe", "<svg"]) {
      expect(html.toLowerCase()).not.toContain(tag);
    }
    // Every copy is there, escaped: name, postcode, summary, flag, two turns, business twice.
    const escaped = payload
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
    expect(html.split(escaped.replaceAll('"', "&quot;")).length - 1).toBeGreaterThanOrEqual(6);
  });

  it("escapes a quote in a link so it can't break out of the href", () => {
    const { html } = callEmail({
      ...EMAIL,
      callUrl: 'https://callmate.example.com/c/x"onmouseover="alert(1)',
      recordingUrl: 'https://callmate.example.com/c/x"/recording',
    });
    expect(html).not.toContain('"onmouseover="');
    expect(html).toContain("&quot;onmouseover=&quot;");
  });

  it("keeps the subject to 150 characters however long the summary", () => {
    const { subject } = callEmail({ ...EMAIL, summary: "Leak ".repeat(200) });
    expect(subject.length).toBeLessThanOrEqual(150);
    expect(subject.startsWith("New enquiry: Sam, 07700 900123 - Leak")).toBe(true);
  });

  it("leaves out the 'Rang from' line when the call-back number is the caller ID", () => {
    const { text } = callEmail({ ...EMAIL, callerId: BASE.callbackNumber });
    expect(text).not.toContain("Rang from");
  });

  it("escapes the business name in the voicemail email too", () => {
    const { html } = voicemailEmail({
      businessName: "<b>Bold</b> Plumbing",
      startedAt: new Date("2026-07-15T10:00:00Z"),
      callbackNumber: null,
      durationSeconds: 12,
      callUrl: CALL_URL,
      recordingUrl: null,
    });
    expect(html).not.toContain("<b>Bold</b>");
    expect(html).toContain("&lt;b&gt;Bold&lt;/b&gt; Plumbing");
    expect(html).toContain("withheld");
  });
});

describe("UK time around the clock changes, midnight and the year's end", () => {
  // 2026's changes: clocks go forward at 01:00 UTC on Sunday 29 March and back at 01:00 UTC
  // on Sunday 25 October.
  it.each([
    ["2026-03-29T00:59:59Z", "Sunday 29 March 2026, 00:59", "2026-03-29 00:59:59"],
    ["2026-03-29T01:00:00Z", "Sunday 29 March 2026, 02:00", "2026-03-29 02:00:00"],
    ["2026-10-25T00:30:00Z", "Sunday 25 October 2026, 01:30", "2026-10-25 01:30:00"],
    ["2026-10-25T01:30:00Z", "Sunday 25 October 2026, 01:30", "2026-10-25 01:30:00"],
    ["2026-10-25T02:00:00Z", "Sunday 25 October 2026, 02:00", "2026-10-25 02:00:00"],
    ["2026-06-30T23:00:00Z", "Wednesday 1 July 2026, 00:00", "2026-07-01 00:00:00"],
    ["2026-06-30T22:59:59Z", "Tuesday 30 June 2026, 23:59", "2026-06-30 23:59:59"],
    ["2026-12-31T23:59:59Z", "Thursday 31 December 2026, 23:59", "2026-12-31 23:59:59"],
    ["2027-01-01T00:00:00Z", "Friday 1 January 2027, 00:00", "2027-01-01 00:00:00"],
    ["2028-02-29T12:00:00Z", "Tuesday 29 February 2028, 12:00", "2028-02-29 12:00:00"],
  ])("shows %s as %s", (iso, words, plain) => {
    expect(formatUkDateTime(new Date(iso))).toBe(words);
    expect(ukDateTime(new Date(iso))).toBe(plain);
  });
});
