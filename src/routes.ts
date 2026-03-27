import { Router } from "express"
import { config, logger } from "./config.js"
import { fetchRecordingAudio, sendVoicemailEmail, sendSmsNotification } from "./utils.js"
import { transcribeAudio } from "./ai.js"

const router = Router()

router.get("/api", (_req, res) => {
    res.json({ success: true })
})

router.post("/api/incoming-call", (_req, res) => {
    logger.info("Incoming call received")

    res.type("text/xml")
    res.send(`
        <Response>
            <Say>
                Hello, this is Phil's voicemail service.
                Please state your name and issue please after the beep.
            </Say>
            <Record action="${config.webhookBaseUrl}/api/recording" maxLength="10" playBeep="true" />
        </Response>
    `)
})

router.post("/api/recording", async (req, res) => {
    const callerNumber = req.body.From || "Unknown"
    const recordingUrl = req.body.RecordingUrl
    const timestamp = new Date().toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: '2-digit' })

    logger.info("Recording received", { from: callerNumber, recordingUrl })

    let audioBuffer: Buffer
    let transcription = ''

    try {
        audioBuffer = await fetchRecordingAudio(recordingUrl)
    } catch (error) {
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
        transcription = await transcribeAudio(audioBuffer)
    } catch (error) {
        logger.error("Failed to transcribe audio", { error, from: callerNumber })
    }

    try {
        await sendVoicemailEmail({ from: callerNumber, timestamp, transcription })
    } catch (error) {
        logger.error("Failed to send voicemail email", { error, from: callerNumber })
    }

    try {
        await sendSmsNotification({ from: callerNumber, timestamp, transcription })
    } catch (error) {
        logger.error("Failed to send SMS notification", { error, from: callerNumber })
    }

    res.type("text/xml")
    res.send(`
        <Response>
            <Say>Thank you. Goodbye.</Say>
        </Response>
    `)
})

router.post("/api/fallback", (req, res) => {
    logger.warn("Fallback handler hit", { body: req.body })

    res.type("text/xml")
    res.send(`
        <Response>
            <Say>Sorry, something went wrong. Please try again later.</Say>
        </Response>
    `)
})

export default router