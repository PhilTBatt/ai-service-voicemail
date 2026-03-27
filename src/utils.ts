import { config, twilioClient, emailTransporter, logger } from "./config.js"

export async function fetchRecordingAudio(recordingUrl: string): Promise<Buffer> {
    const response = await fetch(recordingUrl + ".mp3", {
        headers: {
            Authorization:
                "Basic " + Buffer.from(`${config.twilio.apiKeySid}:${config.twilio.apiKeySecret}`).toString("base64"),
        }
    })

    if (!response.ok) {
        throw new Error(`Failed to fetch recording: ${response.status} ${response.statusText}`)
    }

    logger.info("Recording fetched", {
        status: response.status,
        contentType: response.headers.get("content-type"),
    })

    return Buffer.from(await response.arrayBuffer())
}

export async function sendVoicemailEmail(params: { from: string, timestamp: string, transcription: string }): Promise<void> {
    await emailTransporter.sendMail({
        from: config.email,
        to: config.email,
        subject: `New Voicemail from ${params.from}`,
        text: `Voicemail received from ${params.from} at ${params.timestamp}`,
        html: `
            <div style="font-family: Arial, sans-serif;">
                <h2>New Voicemail</h2>
                <p><strong>From:</strong> ${params.from}</p>
                <p><strong>At:</strong> ${params.timestamp}</p>
                <p><strong>Transcription:</strong> ${params.transcription}</p>
            </div>
        `
    })

    logger.info("Voicemail email sent", { from: params.from })
}

export async function sendSmsNotification(params: { from: string, timestamp: string, transcription: string }): Promise<void> {
    const body = `New enquiry from ${params.from} at ${params.timestamp}:\n${params.transcription}`
    await twilioClient.messages.create({ body, from: config.twilio.phoneNumber, to: config.targetPhoneNumber })

    logger.info("SMS notification sent", { from: params.from })
}