import express from "express"
import dotenv from "dotenv"
import nodemailer from "nodemailer"
import twilio from "twilio"
import winston from "winston"

const app = express()
const PORT = 3000

dotenv.config()

const logger = winston.createLogger({
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

const missing = REQUIRED_ENV_VARS.filter( key => !process.env[key])
if (missing.length > 0) {
    logger.error(`\n Missing required environment variables: ${missing.join(", ")}`)
    process.exit(1)
}

const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
)

const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.PHILSEMAIL,
        pass: process.env.GMAIL_APP_PASSWORD
    }
})

const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL

app.use(express.urlencoded({ extended: true }))
app.use(express.json())

app.get("/api", (req, res) => {
    res.json({ success: true })
});

app.post("/api/incoming-call", (req, res) => {
    logger.info("Incoming call received")
    res.type("text/xml")

    res.send(`
        <Response>
            <Say>
                Hello, this is your AI voicemail service.
                Please state your name and issue please after the beep.
            </Say>

            <Record action="${WEBHOOK_BASE_URL}/api/recording" maxLength="10" playBeep="true" />
        </Response>
    `)
})

app.post("/api/recording", async (req, res) => {
    const callerNumber = req.body.From || "Unknown"
    const recordingUrl = req.body.RecordingUrl
    const timestamp = new Date().toLocaleString()
    let audioBuffer: Buffer

    logger.info("Recording received", { from: callerNumber, recordingUrl })

    try { 

        const response = await fetch(recordingUrl + ".mp3", {
            headers: { 
                Authorization: "Basic " + Buffer.from( `${process.env.TWILIO_API_KEY_SID}:${process.env.TWILIO_API_KEY_SECRET}` ).toString("base64") 
            }
        })

        if (!response.ok) throw new Error(`Failed to fetch recording: ${response.status} ${response.statusText}`) 

        logger.info("Recording fetched", {
            status: response.status,
            contentType: response.headers.get("content-type"),
        })

        audioBuffer = Buffer.from(await response.arrayBuffer())
    }
    catch (error) {
        logger.error("Failed to fetch recording audio", { error, recordingUrl })
    
        res.type("text/xml")
        res.send(`
            <Response>
                <Say>Sorry, something went wrong processing your message.</Say>
            </Response>
        `)
        return
    }
    try {
        await transporter.sendMail({
            from: process.env.PHILSEMAIL,
            to: process.env.PHILSEMAIL,
            subject: "New Voicemail from ${callerNumber}",
            text: `Voicemail received from ${callerNumber} at ${timestamp}\n`,
            html: `
                    <div style="font-family: Arial;">
                        <h2>New Voicemail</h2>
                        <p><strong>From:</strong> ${req.body.From}</p>
                        <p><strong>Time:</strong> ${timestamp}</p>
                    </div>
                `,
            attachments: [
                {
                    filename: `voicemail-${Date.now()}.mp3`,
                    content: audioBuffer
                }
                ]
        })
        logger.info("Voicemail email sent", { from: callerNumber })
    } catch (error) {
        logger.error("Failed to send voicemail email", { error, from: callerNumber })
    }
    try {
        await client.messages.create({
            body: `New enquiry from ${req.body.From}. Voicemail received at ${timestamp}.`,
            from: process.env.TWILIO_PHONE_NUMBER!,
            to: process.env.TARGET_PHONE_NUMBER!
        })

        logger.info("SMS notification sent", { from: callerNumber })
    } catch (error) {
        logger.error("Failed to send SMS notification", { error, from: callerNumber })
    }

    res.type("text/xml")

    res.send(`
        <Response>
            <Say> Thank you. Goodbye. </Say>
        </Response>
    `)
})

app.post("/api/fallback", (req, res) => {
    logger.warn("Fallback handler hit", { body: req.body })

    res.type("text/xml")

    res.send(`
        <Response>
            <Say>Sorry, something went wrong. Please try again later.</Say>
        </Response>
    `)
})

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`)
})