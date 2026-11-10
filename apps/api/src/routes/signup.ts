// Signing up through a link (BUILD_PLAN Step 11). Mounted at /api/signup, ahead of the
// dashboard API, because the person following a link has no account yet: they must be signed
// in with the login provider (so their email is verified), but nobody has invited them.
//
//   GET  /api/signup/:code  is the link usable? And which documents will they accept? No login.
//   POST /api/signup        create the business and its owner, for the person signed in.
import {
  LEGAL_DOCUMENTS,
  signupInputSchema,
  type SignupLinkView,
  type SignupResultView,
} from "@callmate/shared";
import { Router, json } from "express";
import { z } from "zod";
import { completeSignup, findSignupLink, type AdminPool } from "../db/cross-tenant.ts";
import { logger } from "../logger.ts";
import type { AuthProvider } from "../providers/auth.ts";
import { bearerToken } from "./dashboard-auth.ts";

export interface SignupOptions {
  admin: AdminPool;
  auth: AuthProvider;
  now?: () => Date;
}

export function signupRouter({ admin, auth, now = () => new Date() }: SignupOptions) {
  const router = Router();
  router.use(json({ limit: "32kb" }));
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.get("/:code", async (req, res) => {
    const check = checkLink(await findSignupLink(admin, req.params.code), now());
    if (!check.ok) {
      res.status(check.status).json({ error: check.error });
      return;
    }
    res.json({
      forTest: check.link.forTest,
      expiresAt: check.link.expiresAt.toISOString(),
      documents: LEGAL_DOCUMENTS,
    } satisfies SignupLinkView);
  });

  router.post("/", async (req, res) => {
    const token = bearerToken(req.headers.authorization);
    const identity = token === "" ? null : await auth.verifyToken(token);
    if (identity === null) {
      res.status(401).json({ error: "Sign in first" });
      return;
    }
    const body = signupInputSchema.safeParse(req.body);
    if (!body.success) {
      res
        .status(400)
        .json({ error: "Invalid signup", issues: z.flattenError(body.error).fieldErrors });
      return;
    }
    // The link first, from our own database, so a bad one costs no call to the login provider
    // (which rate-limits us). The transaction below checks it again, with the row locked.
    const check = checkLink(await findSignupLink(admin, body.data.code), now());
    if (!check.ok) {
      res.status(409).json({ error: check.error });
      return;
    }
    // The account is tied to a verified address, so nobody can sign up as someone else.
    const loginEmail = await auth.verifiedEmail(identity.subject);
    if (loginEmail === null) {
      res.status(403).json({ error: "Your email address needs verifying before you sign up" });
      return;
    }
    const result = await completeSignup(admin, {
      input: body.data,
      subject: identity.subject,
      loginEmail,
      now: now(),
    });
    if (result.outcome === "refused") {
      res.status(409).json({ error: result.reason });
      return;
    }
    logger.info("Business signed up", { tenantId: result.tenantId });
    res.status(201).json({ tenantId: result.tenantId } satisfies SignupResultView);
  });

  return router;
}

type SignupLink = NonNullable<Awaited<ReturnType<typeof findSignupLink>>>;

/**
 * Whether a link can be followed, with the same words completeSignup refuses it with (it
 * checks again inside its transaction, with the row locked, so two people can't share one).
 */
function checkLink(
  link: SignupLink | null,
  now: Date,
): { ok: true; link: SignupLink } | { ok: false; status: 404 | 410; error: string } {
  if (!link) return { ok: false, status: 404, error: "This signup link isn't valid" };
  if (link.usedAt) {
    return { ok: false, status: 410, error: "This signup link has already been used" };
  }
  if (link.expiresAt <= now) {
    return { ok: false, status: 410, error: "This signup link has expired; ask for a new one" };
  }
  return { ok: true, link };
}
