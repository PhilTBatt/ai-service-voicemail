// Postmark's bounce and spam-complaint webhooks (decision 010). Postmark doesn't sign
// webhooks; the docs (read 2026-11-07) say to protect the URL with HTTP Basic auth and an IP
// allowlist, so the webhook URL registered at Postmark carries a username and password that
// must match POSTMARK_WEBHOOK_SECRET. A bounce or complaint marks the email undelivered
// with Postmark's reason and raises an alert, whichever of our emails it was (a call's, a
// billing email, a cancellation, a deletion's confirmation); a complaint is also Postmark
// deactivating that address for good. An event that arrives before the send job has saved the
// email's ID is kept, and the job applies it when it saves the ID (db/delivery-receipts.ts).
//
// Every answer but a refusal is 200, not 204: Postmark's docs (read 2026-11-13) say "any response
// other than a 200 counts as a failure", and its Verify webhook button checks for a 200.
import { timingSafeEqual } from "node:crypto";
import { Router, json } from "express";
import type pg from "pg";
import { z } from "zod";
import { raiseAlert, type AlertFn } from "../alerts.ts";
import { recordReceipt } from "../db/delivery-receipts.ts";
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

  const expected = Buffer.from(
    `Basic ${Buffer.from(`${POSTMARK_WEBHOOK_USER}:${webhookSecret}`).toString("base64")}`,
  );

  router.post("/", async (req, res) => {
    const given = Buffer.from(req.headers.authorization ?? "");
    // Same byte length first (timingSafeEqual throws otherwise), then a comparison that takes
    // the same time whether the first or the last byte differs: Buffer.equals stops at the first.
    const matches = given.length === expected.length && timingSafeEqual(given, expected);
    if (!matches) {
      logger.warn("Rejected Postmark webhook", { reason: "bad or missing Basic auth" });
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const parsed = eventSchema.safeParse(req.body);
    if (!parsed.success) {
      // Other record types (Delivery, Open...) aren't subscribed to; if one arrives, say fine.
      res.status(200).end();
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
      res.status(200).end();
      return;
    }
    const { tenantId } = await recordReceipt(
      pool,
      {
        medium: "email",
        providerRef: messageId,
        status: "undelivered",
        failureCode: type,
        alert: {
          name: record === "SpamComplaint" ? "email-spam-complaint" : "email-bounced",
          details: { type, addressDeactivated: inactive ?? false },
        },
      },
      alert,
    );
    if (tenantId === null) {
      // Either quicker than the send job saving the ID, which applies it when it does, or an
      // email no business has (an alert email to Phil, say), whose event expires.
      logger.info("Postmark event kept: no email has its ID yet", { record, type });
    } else {
      logger.info("Postmark event handled", { record, type, tenantId });
    }
    res.status(200).end();
  });

  return router;
}
