/** A recording's audio as a provider serves it, for the API to stream on to the user. */
export interface RecordingAudio {
  contentType: string;
  body: ReadableStream<Uint8Array>;
}
