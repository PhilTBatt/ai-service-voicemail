import express from "express"
import dotenv from "dotenv"
import nodemailer from "nodemailer"

const app = express()
const PORT = 3000

dotenv.config()

const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.PHILSEMAIL,
        pass: process.env.GMAIL_APP_PASSWORD
    }
})

app.use(express.urlencoded({ extended: true }))
app.use(express.json())

app.get("/api", (req, res) => {
    res.json({ success: true })
});

app.post("/incoming-call", (req, res) => {
    res.type("text/xml")

    res.send(`
        <Response>
            <Say>
                Hello, this is your AI voicemail service.
                Please state your name and issue please after the beep.
            </Say>

            <Record action="/recording" maxLength="15" playBeep="true" />
        </Response>
    `);
});

app.post("/recording", async (req, res) => {
    const recordingUrl = req.body.RecordingUrl

    console.log("Recording URL:", recordingUrl)
    console.log("From:", req.body.From)
    
    await transporter.sendMail({
        from: process.env.PHILSEMAIL,
        to: process.env.PHILSEMAIL,
        subject: "New Voicemail",
        text: `Voicemail received:\n${recordingUrl}`
    })

    res.type("text/xml")

    res.send(`
        <Response>
            <Say> Thank you. Goodbye. </Say>
        </Response>
    `);
});

app.post("/fallback", (req, res) => {
    console.log("Fallback hit")

    res.type("text/xml")

    res.send(`
        <Response>
            <Say>Sorry, something went wrong. Please try again later.</Say>
        </Response>
    `);
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`)
});