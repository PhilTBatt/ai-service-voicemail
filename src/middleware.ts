import type { Request, Response, NextFunction } from "express"
import twilio from "twilio"
import { config, logger } from "./config.js"

export function validateTwilioSignature(req: Request, res: Response, next: NextFunction): void {
    const signature = req.headers["x-twilio-signature"] as string

    if (!signature) {
        logger.warn("Request missing Twilio signature", {
            ip: req.ip,
            path: req.path,
        })
        res.status(403).json({ error: "Forbidden" })
        return
    }

    const url = `${config.webhookBaseUrl}${req.originalUrl}`
    const params = req.body || {}

    const isValid = twilio.validateRequest(config.twilio.authToken, signature, url, params)

    if (!isValid) {
        logger.warn("Invalid Twilio signature", { ip: req.ip,  path: req.path })
        res.status(403).json({ error: "Forbidden" })
        return
    }

    next()
}