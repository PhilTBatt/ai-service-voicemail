import { logger } from "./config.js"

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