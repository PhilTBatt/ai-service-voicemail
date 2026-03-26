import express from "express"
import dotenv from "dotenv"
import nodemailer from "nodemailer"
import twilio from "twilio"

const app = express()
const PORT = 3000

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
    console.error(`\n Missing required environment variables:\n${missing.map( v => `  - ${v}`).join("\n")}\n`)
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
    try { 
        const recordingUrl = req.body.RecordingUrl
        const timestamp = new Date().toLocaleString()

        const response = await fetch(recordingUrl + ".mp3", {
            headers: { 
                Authorization: "Basic " + Buffer.from( `${process.env.TWILIO_API_KEY_SID}:${process.env.TWILIO_API_KEY_SECRET}` ).toString("base64") 
            }
        })

        console.log("Content-Type:", response.headers.get("content-type"))
        console.log("Status:", response.status)

        const audioBuffer = Buffer.from(await response.arrayBuffer())
        
        await transporter.sendMail({
            from: process.env.PHILSEMAIL,
            to: process.env.PHILSEMAIL,
            subject: "New Voicemail",
            text: `Voicemail received:\n${recordingUrl}`,
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

        const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER
        const TARGET_PHONE_NUMBER = process.env.TARGET_PHONE_NUMBER

        if (!TWILIO_PHONE_NUMBER || !TARGET_PHONE_NUMBER) throw new Error("Missing required environment variables") 
            
        await client.messages.create({
            body: `New enquiry from ${req.body.From}. Voicemail received at ${timestamp}.`,
            from: TWILIO_PHONE_NUMBER,
            to: TARGET_PHONE_NUMBER
        })


        res.type("text/xml")

        res.send(`
            <Response>
                <Say> Thank you. Goodbye. </Say>
            </Response>
        `)
    } catch (error) {
        console.error("Error handling recording:", error)
        res.type("text/xml")
        res.send(`
            <Response>
                <Say>Something went wrong</Say>
            </Response>
        `)
    }
})

app.post("/api/fallback", (req, res) => {
    console.log("Fallback hit")

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