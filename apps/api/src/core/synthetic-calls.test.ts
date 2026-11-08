import type { Urgency } from "@callmate/shared";
import { describe, expect, it } from "vitest";
import {
  evaluateSyntheticCall,
  waitForSyntheticCall,
  type ObservedCall,
  type SyntheticCheckOptions,
} from "./synthetic-calls.ts";

const PLACED = new Date("2026-11-07T22:00:00Z");
const ENDED = new Date("2026-11-07T22:01:30Z");
/** A moment this many seconds after the call ended (before it, if negative). */
const at = (seconds: number) => new Date(ENDED.getTime() + seconds * 1000);
const afterPlacing = (seconds: number) => new Date(PLACED.getTime() + seconds * 1000);

const options = (
  now: Date,
  overrides: Partial<SyntheticCheckOptions> = {},
): SyntheticCheckOptions => ({
  placedAt: PLACED,
  now,
  callDeadlineSeconds: 600,
  notifyWithinSeconds: 60,
  expectEmail: true,
  ...overrides,
});

type Message = ObservedCall["notifications"][number];
const message = (
  channel: Message["channel"],
  seconds: number,
  status: Message["status"] = "sent",
): Message => ({ channel, status, statusAt: at(seconds) });
const processed = (urgency: Urgency | null, notifications: Message[]): ObservedCall => ({
  call: { endedAt: ENDED, urgency, processed: true },
  notifications,
});

describe("evaluateSyntheticCall", () => {
  it("passes a gas call whose four messages all went within the minute, and says how fast", () => {
    const observed = processed("emergency", [
      message("sms_emergency", -40), // sent mid-call by the platform's function
      message("sms_caller", 12, "delivered"),
      message("sms", 20),
      message("email", 21),
    ]);
    expect(evaluateSyntheticCall("gas", observed, options(at(30)))).toEqual({
      result: "passed",
      slowestSeconds: 21,
    });
  });

  it("waits for the call to be stored, and fails once the deadline has passed", () => {
    const nothing: ObservedCall = { call: null, notifications: [] };
    expect(evaluateSyntheticCall("routine", nothing, options(afterPlacing(60)))).toEqual({
      result: "waiting",
      for: ["the call to be stored"],
    });
    expect(evaluateSyntheticCall("routine", nothing, options(afterPlacing(601)))).toEqual({
      result: "failed",
      problems: ["No call stored 601 s after it was placed"],
    });
  });

  it("waits while the call is still going", () => {
    const going: ObservedCall = {
      call: { endedAt: null, urgency: null, processed: false },
      notifications: [message("sms_emergency", -60)],
    };
    expect(evaluateSyntheticCall("gas", going, options(afterPlacing(90)))).toEqual({
      result: "waiting",
      for: ["the call to end"],
    });
  });

  it("waits for processing and the messages for a minute after the call, then fails", () => {
    const unprocessed: ObservedCall = {
      call: { endedAt: ENDED, urgency: null, processed: false },
      notifications: [],
    };
    expect(evaluateSyntheticCall("routine", unprocessed, options(at(10)))).toEqual({
      result: "waiting",
      for: ["the call to be processed", "the summary text", "the summary email"],
    });
    expect(evaluateSyntheticCall("routine", unprocessed, options(at(61)))).toEqual({
      result: "failed",
      problems: [
        "The call wasn't processed within 60 s of ending",
        "No summary text within 60 s of the call ending",
        "No summary email within 60 s of the call ending",
      ],
    });
  });

  it("fails a routine call that set off an emergency text, straight away", () => {
    const observed = processed("routine", [message("sms_emergency", 5), message("sms", 10)]);
    expect(evaluateSyntheticCall("routine", observed, options(at(11)))).toEqual({
      result: "failed",
      problems: ["The emergency text to the tradesperson went out, and shouldn't have"],
    });
  });

  it("fails a gas call the extraction called routine", () => {
    const observed = processed("routine", [
      message("sms_emergency", 0),
      message("sms_caller", 1),
      message("sms", 2),
      message("email", 2),
    ]);
    expect(evaluateSyntheticCall("gas", observed, options(at(5)))).toEqual({
      result: "failed",
      problems: ["The call's urgency is routine, not emergency"],
    });
  });

  it("fails a message that went too late, and one the allowlist stopped", () => {
    const observed = processed("other", [message("sms", 75), message("email", 3, "blocked")]);
    expect(evaluateSyntheticCall("silence", observed, options(at(80)))).toEqual({
      result: "failed",
      problems: [
        "The summary text went 75 s after the call ended (limit 60 s)",
        "The summary email was blocked",
      ],
    });
  });

  it("gives a failed message its retries until the minute is up", () => {
    const observed = processed("routine", [message("sms", 5, "failed"), message("email", 5)]);
    expect(evaluateSyntheticCall("routine", observed, options(at(30)))).toEqual({
      result: "waiting",
      for: ["the summary text"],
    });
    expect(evaluateSyntheticCall("routine", observed, options(at(61)))).toEqual({
      result: "failed",
      problems: ["The summary text failed and hadn't gone 60 s after the call ended"],
    });
  });

  it("expects no email from a business without an address", () => {
    const observed = processed("spam", [message("sms", 8)]);
    expect(
      evaluateSyntheticCall("silence", observed, options(at(9), { expectEmail: false })),
    ).toEqual({ result: "passed", slowestSeconds: 8 });
  });
});

describe("waitForSyntheticCall", () => {
  /** A clock the waiting moves on, instead of real time. */
  function fakeTime() {
    let clock = PLACED.getTime();
    return {
      now: () => new Date(clock),
      sleep: (milliseconds: number) => {
        clock += milliseconds;
        return Promise.resolve();
      },
    };
  }
  const settings = { placedAt: PLACED, callDeadlineSeconds: 600, notifyWithinSeconds: 60 };

  it("looks again until the call has passed", async () => {
    const views: ObservedCall[] = [
      { call: null, notifications: [] },
      { call: { endedAt: ENDED, urgency: null, processed: false }, notifications: [] },
      processed("routine", [message("sms", 15), message("email", 16)]),
    ];
    let looks = 0;
    const result = await waitForSyntheticCall(
      "routine",
      () => Promise.resolve(views[Math.min(looks++, views.length - 1)]!),
      { ...settings, expectEmail: true, pollSeconds: 5, ...fakeTime() },
    );
    expect(result).toEqual({ result: "passed", slowestSeconds: 16 });
    expect(looks).toBe(3);
  });

  it("gives up, saying why, when the call never comes", async () => {
    const result = await waitForSyntheticCall(
      "gas",
      () => Promise.resolve({ call: null, notifications: [] }),
      { ...settings, expectEmail: true, pollSeconds: 30, ...fakeTime() },
    );
    expect(result).toEqual({
      result: "failed",
      problems: ["No call stored 630 s after it was placed"],
    });
  });
});
