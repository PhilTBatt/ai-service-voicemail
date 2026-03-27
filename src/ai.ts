import OpenAI from "openai"
import { logger } from "./config.js"

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
})

export async function transcribeAudio(audioBuffer: Buffer): Promise<string> {
    const formData = new FormData()
    const audioBlob = new Blob([new Uint8Array(audioBuffer)], { type: "audio/mpeg" })
    formData.append("file", audioBlob, "voicemail.mp3")
    formData.append("model", "whisper-1")
    formData.append("language", "en")

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: formData,
    })

    if (!response.ok) {
        const errorBody = await response.text()
        logger.error("Whisper API error", { status: response.status, body: errorBody })
        throw new Error(`Whisper API error: ${response.status} ${errorBody}`)
    }

    const data = await response.json()
    const transcript = data.text?.trim() || ""

    logger.info("Audio transcribed", {
        length: transcript.length,
        preview: transcript.substring(0, 80),
    })

    return transcript
}

export async function summariseCall(transcript: string): Promise<string> {
    if (!transcript) return ""

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: "Summarise voicemail messages clearly and concisely."
                },
                {
                    role: "user",
                    content: `
                        Extract the following from this voicemail:
                        - Name
                        - Issue
                        - Urgency (low, medium, high)
                        Voicemail:
                        ${transcript}
                    `
                }
            ],
            temperature: 0.2,
        })

        logger.info("Transcription summarised", {
            length: transcript.length,
            preview: transcript.substring(0, 80),
        })

        return response.choices[0]?.message?.content?.trim() || ""
    } catch (error) {
        logger.error("Summarisation failed", { error })
        return transcript
    }
}