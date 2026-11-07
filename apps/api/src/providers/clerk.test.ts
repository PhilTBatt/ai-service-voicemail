import {
  ClerkAPIResponseError,
  TokenVerificationError,
  TokenVerificationErrorReason,
} from "@clerk/backend/errors";
import { describe, expect, it } from "vitest";
import { ClerkAuthProvider, type ClerkCalls, type ClerkUserEmails } from "./clerk.ts";

const OPTIONS = { secretKey: "sk_test_fake", authorizedParties: ["http://localhost:5173"] };

function providerWith(calls: Partial<ClerkCalls>) {
  return new ClerkAuthProvider(OPTIONS, {
    verify: () => Promise.reject(new Error("verify not stubbed")),
    getUser: () => Promise.reject(new Error("getUser not stubbed")),
    deleteUser: () => Promise.reject(new Error("deleteUser not stubbed")),
    ...calls,
  });
}

const refused = (reason: string) =>
  new TokenVerificationError({ message: "refused for the test", reason });

describe("ClerkAuthProvider.verifyToken", () => {
  it("returns the Clerk user ID from the token's sub claim", async () => {
    const provider = providerWith({ verify: () => Promise.resolve({ sub: "user_abc" }) });
    expect(await provider.verifyToken("a.b.c")).toEqual({ subject: "user_abc" });
  });

  it("treats a bad token as not logged in", async () => {
    for (const reason of [
      TokenVerificationErrorReason.TokenExpired,
      TokenVerificationErrorReason.TokenInvalidSignature,
      TokenVerificationErrorReason.TokenInvalidAuthorizedParties,
      TokenVerificationErrorReason.JWKKidMismatch,
    ]) {
      const provider = providerWith({ verify: () => Promise.reject(refused(reason)) });
      expect(await provider.verifyToken("a.b.c"), reason).toBeNull();
    }
  });

  it("raises an error when Clerk can't be reached or the key is wrong", async () => {
    for (const reason of [
      TokenVerificationErrorReason.RemoteJWKFailedToLoad,
      TokenVerificationErrorReason.InvalidSecretKey,
    ]) {
      const provider = providerWith({ verify: () => Promise.reject(refused(reason)) });
      await expect(provider.verifyToken("a.b.c"), reason).rejects.toThrow(TokenVerificationError);
    }
    const offline = providerWith({ verify: () => Promise.reject(new TypeError("fetch failed")) });
    await expect(offline.verifyToken("a.b.c")).rejects.toThrow("fetch failed");
  });

  it("refuses a token without a subject", async () => {
    expect(await providerWith({ verify: () => Promise.resolve({}) }).verifyToken("x")).toBeNull();
    expect(
      await providerWith({ verify: () => Promise.resolve({ sub: "" }) }).verifyToken("x"),
    ).toBeNull();
  });
});

describe("ClerkAuthProvider.verifiedEmail", () => {
  const user = (
    primary: string | null,
    addresses: [id: string, email: string, status: string | null][],
  ): ClerkUserEmails => ({
    primaryEmailAddressId: primary,
    emailAddresses: addresses.map(([id, emailAddress, status]) => ({
      id,
      emailAddress,
      verification: status === null ? null : { status },
    })),
  });

  it("returns the primary address when Clerk has verified it", async () => {
    const provider = providerWith({
      getUser: () =>
        Promise.resolve(
          user("idn_2", [
            ["idn_1", "old@example.com", "verified"],
            ["idn_2", "sam@example.com", "verified"],
          ]),
        ),
    });
    expect(await provider.verifiedEmail("user_abc")).toBe("sam@example.com");
  });

  it("returns nothing for an unverified, missing or dangling primary address", async () => {
    for (const shape of [
      user("idn_1", [["idn_1", "sam@example.com", "unverified"]]),
      user("idn_1", [["idn_1", "sam@example.com", null]]),
      user(null, [["idn_1", "sam@example.com", "verified"]]),
      user("idn_9", [["idn_1", "sam@example.com", "verified"]]),
    ]) {
      const provider = providerWith({ getUser: () => Promise.resolve(shape) });
      expect(await provider.verifiedEmail("user_abc")).toBeNull();
    }
  });

  it("lets a Clerk API failure surface as an error", async () => {
    const provider = providerWith({ getUser: () => Promise.reject(new Error("Clerk is down")) });
    await expect(provider.verifiedEmail("user_abc")).rejects.toThrow("Clerk is down");
  });
});

describe("ClerkAuthProvider.deleteLogin", () => {
  it("deletes the user at Clerk", async () => {
    const deleted: string[] = [];
    const provider = providerWith({
      deleteUser: (userId) => {
        deleted.push(userId);
        return Promise.resolve({});
      },
    });
    await provider.deleteLogin("user_abc");
    expect(deleted).toEqual(["user_abc"]);
  });

  it("counts a user Clerk no longer has as deleted", async () => {
    const gone = new ClerkAPIResponseError("Not Found", { data: [], status: 404 });
    const provider = providerWith({ deleteUser: () => Promise.reject(gone) });
    await expect(provider.deleteLogin("user_gone")).resolves.toBeUndefined();
  });

  it("passes on any other failure", async () => {
    const down = new ClerkAPIResponseError("Internal Server Error", { data: [], status: 500 });
    const provider = providerWith({ deleteUser: () => Promise.reject(down) });
    await expect(provider.deleteLogin("user_abc")).rejects.toBe(down);
  });
});
