import { describe, expect, it } from "vitest";
import { decodeTaskCommand, encodeTaskCommand } from "./task-command.ts";

describe("task commands", () => {
  it("carry a script and its arguments through az's own option parsing untouched", () => {
    const encoded = encodeTaskCommand("invite-user --email phil@example.com --role admin");
    // Nothing az could take for one of its options: no "-" at the start, no spaces.
    expect(encoded).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_-]*$/);
    expect(decodeTaskCommand(encoded)).toEqual({
      script: "invite-user",
      args: ["--email", "phil@example.com", "--role", "admin"],
    });
  });

  it("takes a script with no arguments, and ignores stray spaces", () => {
    expect(decodeTaskCommand(encodeTaskCommand("  live-configure-number   --confirm "))).toEqual({
      script: "live-configure-number",
      args: ["--confirm"],
    });
  });

  it.each([
    ["", /empty/],
    ["../secrets --x", /isn't a script name/],
    ["scripts/invite-user", /isn't a script name/],
    ["Invite-User", /isn't a script name/],
  ])("refuses %j", (line, error) => {
    expect(() => decodeTaskCommand(encodeTaskCommand(line))).toThrow(error);
  });
});
