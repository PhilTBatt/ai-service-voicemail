// Shared by the load-test API (load-server.ts) and its runner (scripts/run-load-test.ts). The
// k6 script gets these as environment variables from the runner.

export const LOAD_API_PORT = 3200;

/**
 * The public origin the load-test API believes it has. The fake Twilio checks webhook
 * signatures over URLs starting with it, so k6 signs with the same one; nothing resolves it.
 */
export const LOAD_PUBLIC_BASE_URL = "https://load.callmate.test";
