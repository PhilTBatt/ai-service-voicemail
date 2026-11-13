// Postmark's outbound stats (postmark-stats.ts), against a stand-in for its API.
import { describe, expect, it } from "vitest";
import { PostmarkStatsApi } from "./postmark-stats.ts";

function stub(body: unknown, status = 200) {
  const requests: { url: string; headers: Record<string, string> | undefined }[] = [];
  const fetchStub: typeof fetch = (input, init) => {
    requests.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      headers: init?.headers as Record<string, string> | undefined,
    });
    return Promise.resolve(Response.json(body, { status }));
  };
  return { fetch: fetchStub, requests };
}

const STATS = {
  Sent: 14,
  Bounced: 1,
  SMTPApiErrors: 0,
  BounceRate: 7.14,
  SpamComplaints: 0,
  SpamComplaintsRate: 0,
  Opens: 3,
};

describe("PostmarkStatsApi", () => {
  it("asks for the days given, both included, with the server's token", async () => {
    const postmark = stub(STATS);
    const stats = new PostmarkStatsApi({ serverToken: "not-a-real-token", fetch: postmark.fetch });
    await stats.outbound({ from: "2026-10-15", to: "2026-11-13" });
    expect(postmark.requests).toEqual([
      {
        url: "https://api.postmarkapp.com/stats/outbound?fromdate=2026-10-15&todate=2026-11-13",
        headers: { Accept: "application/json", "X-Postmark-Server-Token": "not-a-real-token" },
      },
    ]);
  });

  it("gives what was sent, bounced and reported as spam", async () => {
    const stats = new PostmarkStatsApi({
      serverToken: "not-a-real-token",
      fetch: stub(STATS).fetch,
    });
    expect(await stats.outbound({ from: "2026-10-15", to: "2026-11-13" })).toEqual({
      sent: 14,
      bounced: 1,
      spamComplaints: 0,
    });
  });

  it("throws with Postmark's status when it refuses", async () => {
    const stats = new PostmarkStatsApi({
      serverToken: "not-a-real-token",
      fetch: stub({ ErrorCode: 10, Message: "Bad or missing Server API token." }, 401).fetch,
    });
    await expect(stats.outbound({ from: "2026-10-15", to: "2026-11-13" })).rejects.toMatchObject({
      name: "PostmarkApiError",
      status: 401,
    });
  });

  it("throws when the answer isn't the documented shape", async () => {
    const stats = new PostmarkStatsApi({
      serverToken: "not-a-real-token",
      fetch: stub({ Sent: "fourteen" }).fetch,
    });
    await expect(stats.outbound({ from: "2026-10-15", to: "2026-11-13" })).rejects.toThrow(
      "Postmark's stats weren't in the documented shape",
    );
  });
});
