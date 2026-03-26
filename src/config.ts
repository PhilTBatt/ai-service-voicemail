import dotenv from "dotenv"
import twilio from "twilio"
import nodemailer from "nodemailer"
import winston from "winston"

dotenv.config()

const REQUIRED_ENV_VARS = [
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_API_KEY_SID",
    "TWILIO_API_KEY_SECRET",
    "TWILIO_PHONE_NUMBER",
    "TARGET_PHONE_NUMBER",
    "PHILSEMAIL",
    "GMAIL_APP_PASSWORD",
    "WEBHOOK_BASE_URL",
]

const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key])
if (missing.length > 0) {
    console.error(`Missing required environment variables:\n${missing.map((v) => `  - ${v}`).join("\n")}\n`)
    process.exit(1)
}

export const logger = winston.createLogger({
    level: "info",
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            ),
        }),
        new winston.transports.File({ filename: "logs/error.log", level: "error" }),
        new winston.transports.File({ filename: "logs/combined.log" }),
    ],
})

export const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID!,
    process.env.TWILIO_AUTH_TOKEN!
)

export const emailTransporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.PHILSEMAIL!,
        pass: process.env.GMAIL_APP_PASSWORD!,
    },
})

export const config = {
    port: process.env.PORT || 3000,
    webhookBaseUrl: process.env.WEBHOOK_BASE_URL!,
    twilio: {
        accountSid: process.env.TWILIO_ACCOUNT_SID!,
        authToken: process.env.TWILIO_AUTH_TOKEN!,
        apiKeySid: process.env.TWILIO_API_KEY_SID!,
        apiKeySecret: process.env.TWILIO_API_KEY_SECRET!,
        phoneNumber: process.env.TWILIO_PHONE_NUMBER!,
    },
    targetPhoneNumber: process.env.TARGET_PHONE_NUMBER!,
    email: process.env.PHILSEMAIL!,
}