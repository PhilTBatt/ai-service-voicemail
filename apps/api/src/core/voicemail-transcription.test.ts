import { describe, expect, it } from "vitest";
import {
  TRANSCRIBABLE_MIN_SECONDS,
  TRANSCRIPT_WAIT_SECONDS,
  recordingSidFromUrl,
  transcriptionMinutes,
  voicemailTranscript,
} from "./voicemail-transcription.ts";

describe("recordingSidFromUrl", () => {
  const sid = "RE0123456789abcdef0123456789abcdef";

  it("takes the recording SID from the reference Twilio's callback and API give", () => {
    expect(
      recordingSidFromUrl(`https://api.twilio.com/2010-04-01/Accounts/AC0/Recordings/${sid}`),
    ).toBe(sid);
    expect(recordingSidFromUrl(`https://api.twilio.com/.../Recordings/${sid}/`)).toBe(sid);
    expect(recordingSidFromUrl(`https://api.twilio.com/.../Recordings/${sid}?x=1`)).toBe(sid);
  });

  it("gives null for anything that isn't a recording SID, so nothing is sent for it", () => {
    expect(recordingSidFromUrl(null)).toBeNull();
    expect(recordingSidFromUrl("")).toBeNull();
    expect(recordingSidFromUrl("rec_ref_1")).toBeNull();
    expect(
      recordingSidFromUrl("https://api.twilio.com/2010-04-01/Accounts/AC0/Recordings/RE1"),
    ).toBeNull();
    expect(
      recordingSidFromUrl("https://example.com/Recordings/CA0123456789abcdef0123456789abcdef"),
    ).toBeNull();
  });
});

describe("voicemailTranscript", () => {
  it("stores the caller's words as one caller turn, in the format a call's transcript uses", () => {
    expect(voicemailTranscript("Hi, it's Sam. My boiler's packed in.")).toBe(
      "caller: Hi, it's Sam. My boiler's packed in.",
    );
  });

  // A transcript is one line a turn: a line break in the words would read as a second turn.
  it("keeps the words to one line and drops control and invisible characters", () => {
    expect(voicemailTranscript("line one\nline two\ttabbed​")).toBe(
      "caller: line one line two tabbed",
    );
  });

  it("is null when nothing was said", () => {
    expect(voicemailTranscript(null)).toBeNull();
    expect(voicemailTranscript("")).toBeNull();
    expect(voicemailTranscript(" \n ")).toBeNull();
  });
});

describe("the transcription limits", () => {
  it("skips recordings Twilio won't transcribe, and waits less than the messages' 60 seconds", () => {
    expect(TRANSCRIBABLE_MIN_SECONDS).toBe(2);
    expect(TRANSCRIPT_WAIT_SECONDS).toBeLessThan(60);
  });

  it("counts each voicemail as whole minutes, rounded up", () => {
    expect(transcriptionMinutes(0)).toBe(0);
    expect(transcriptionMinutes(1)).toBe(1);
    expect(transcriptionMinutes(60)).toBe(1);
    expect(transcriptionMinutes(61)).toBe(2);
    expect(transcriptionMinutes(120)).toBe(2);
  });
});
