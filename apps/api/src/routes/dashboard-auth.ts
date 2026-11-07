// Who is calling the dashboard API, and what they may touch (BUILD_PLAN Step 10).
//
// Two layers. The login provider answers "who is this?" from the bearer token. Our own tables
// answer "what are they to us?": owner (their own tenants), admin (everything) or reseller
// (the tenant list and counts, never call content). Both answers travel on res.locals, so a
// route reads `principalOf(res)` and never touches the token.
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type pg from "pg";
import {
  claimAccountByEmail,
  findAccountBySubject,
  type Account,
  type Role,
} from "../db/accounts.ts";
import { logger } from "../logger.ts";
import type { AuthProvider } from "../providers/auth.ts";

/** The logged-in person, as the rest of the request sees them. */
export type Principal = Account;

const PRINCIPAL = "principal";
const TENANT_ID = "tenantId";

export function principalOf(res: Response): Principal {
  const principal: unknown = res.locals[PRINCIPAL];
  if (!principal) throw new Error("principalOf() called before authenticate()");
  return principal as Principal;
}

/**
 * Turns the Authorization header into a principal. 401 when there's no usable token (the
 * dashboard should send the person to log in); 403 when the token is fine but nobody has
 * invited that person (they're logged in with the provider, but have no account here). A
 * first login claims the invitation that matches the provider's verified email; only then is
 * the provider asked for the email, so an ordinary request costs no call to it.
 */
/** The token in an "Authorization: Bearer ..." header, or "" when there isn't one. */
export function bearerToken(header: string | undefined): string {
  const value = header ?? "";
  return value.startsWith("Bearer ") ? value.slice("Bearer ".length).trim() : "";
}

export function authenticate(pool: pg.Pool, auth: AuthProvider): RequestHandler {
  return async (req, res, next) => {
    const token = bearerToken(req.headers.authorization);
    if (token === "") {
      res.status(401).json({ error: "Login required" });
      return;
    }
    const identity = await auth.verifyToken(token);
    if (identity === null) {
      res.status(401).json({ error: "Login required" });
      return;
    }
    let account = await findAccountBySubject(pool, identity.subject);
    if (account === null) {
      const email = await auth.verifiedEmail(identity.subject);
      if (email !== null) account = await claimAccountByEmail(pool, identity.subject, email);
    }
    if (account === null) {
      // The subject is opaque, so it's safe to log; the email isn't, and the logger would
      // redact it anyway.
      logger.warn("Logged-in person has no account", { subject: identity.subject });
      res.status(403).json({ error: "No account for this login" });
      return;
    }
    res.locals[PRINCIPAL] = account;
    next();
  };
}

/** The tenant a request under /tenants/:tenantId is about. Set by requireTenantAccess(). */
export function tenantIdOf(res: Response): string {
  const tenantId: unknown = res.locals[TENANT_ID];
  if (typeof tenantId !== "string") throw new Error("tenantIdOf() called outside a tenant route");
  return tenantId;
}

/** Lets only these roles past. */
export function requireRole(...roles: Role[]): RequestHandler {
  return (_req, res, next) => {
    if (roles.includes(principalOf(res).role)) next();
    else res.status(403).json({ error: "Forbidden" });
  };
}

/**
 * For routes under /tenants/:tenantId. Admins reach every tenant, owners only their own, and
 * the reseller none: everything under a tenant is content Ant must never see.
 */
export function requireTenantAccess(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const { tenantId } = req.params;
    const principal = principalOf(res);
    const allowed =
      typeof tenantId === "string" &&
      (principal.role === "admin" ||
        (principal.role === "owner" && principal.tenantIds.includes(tenantId)));
    if (!allowed) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    res.locals[TENANT_ID] = tenantId;
    next();
  };
}
