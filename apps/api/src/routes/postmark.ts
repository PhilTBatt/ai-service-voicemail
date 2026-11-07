// Postmark's bounce and spam-complaint webhooks (decision 010). Postmark doesn't sign
// webhooks; the docs (read 2026-11-08) say to protect the URL with HTTP Basic auth and an IP
// allowlist, so the webhook URL registered at Postmark carries a username and password that
// must match POSTMARK_WEBHOOK_SECRET. A bounce or complaint marks the email undelivered
// with Postmark's reason and raises an alert; a complaint is also Postmark deactivating that
// address for good.
import { Router, json } from "express";
import type pg from "pg";
import { z } from "zod";
import { raiseAlert, type AlertFn } from "../alerts.ts";
import { findTenantIdByProviderRef } from "../db/cross-tenant.ts";
import { withTenant } from "../db/tenant.ts";
import { logger } from "../logger.ts";

export interface PostmarkRouteOptions {
  pool: pg.Pool;
  /** The password part of the Basic auth in the webhook URL (username is "postmark"). */
  webhookSecret: string;
  alert?: AlertFn;
}

export const POSTMARK_WEBHOOK_USER = "postmark";

const eventSchema = z.object({
  RecordType: z.enum(["Bounce", "SpamComplaint"]),
  MessageID: z.string().min(1),
  /** "HardBounce", "Transient", "SpamComplaint" and so on. */
  Type: z.string().min(1),
  TypeCode: z.number().optional(),
  Inactive: z.boolean().optional(),
});

export function postmarkRouter({ pool, webhookSecret, alert = raiseAlert }: PostmarkRouteOptions) {
  const router = Router();
  router.use(json({ limit: "1mb" }));

  const expected = `Basic ${Buffer.from(`${POSTMARK_WEBHOOK_USER}:${webhookSecret}`).toString("base64")}`;

  router.post("/", async (req, res) => {
    const given = req.headers.authorization ?? "";
    const matches =
      given.length === expected.length && Buffer.from(given).equals(Buffer.from(expected)); // same length first, so no timing hint
    if (!matches) {
      logger.warn("Rejected Postmark webhook", { reason: "bad or missing Basic auth" });
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const parsed = eventSchema.safeParse(req.body);
    if (!parsed.success) {
      // Other record types (Delivery, Open...) aren't subscribed to; if one arrives, say fine.
      res.status(204).end();
      return;
    }
    const {
      RecordType: record,
      MessageID: messageId,
      Type: type,
      Inactive: inactive,
    } = parsed.data;

    // A transient bounce may still deliver; only the final verdicts change the row.
    const final = record === "SpamComplaint" || type !== "Transient";
    if (!final) {
      res.status(204).end();
      return;
    }
    const tenantId = await findTenantIdByProviderRef(pool, messageId);
    if (tenantId === null) {
      logger.info("Postmark event for an email we don't know", { record, type });
      res.status(204).end();
      return;
    }
    const row = await withTenant(
      pool,
      tenantId,
      async (client) =>
        (
          await client.query<{ call_id: string }>(
            `UPDATE notifications SET status = 'undelivered', failure_code = $2
             WHERE provider_ref = $1 AND channel = 'email' AND status IN ('sent', 'delivered', 'undelivered')
             RETURNING call_id`,
            [messageId, type],
          )
        ).rows[0],
    );
    if (row) {
      alert(record === "SpamComplaint" ? "email-spam-complaint" : "email-bounced", {
        tenantId,
        callId: row.call_id,
        type,
        addressDeactivated: inactive ?? false,
      });
    }
    logger.info("Postmark event handled", { record, type, tenantId });
    res.status(204).end();
  });

  return router;
}
