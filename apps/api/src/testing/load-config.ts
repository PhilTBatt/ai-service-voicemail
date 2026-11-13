// Shared by the load-test API (load-server.ts), its worker (load-worker.ts) and their runner
// (scripts/run-load-test.ts). The k6 script gets these as environment variables from the runner.

export const LOAD_API_PORT = 3200;

/**
 * The public origin the load-test API believes it has. The fake Twilio checks webhook
 * signatures over URLs starting with it, so k6 signs with the same one; nothing resolves it.
 */
export const LOAD_PUBLIC_BASE_URL = "https://load.callmate.test";

/** How many businesses the load test seeds: LOAD_CUSTOMERS, 100 by default, 1,000 at most. */
export function loadCustomers(): number {
  const customers = Number(process.env.LOAD_CUSTOMERS ?? "100");
  if (!Number.isInteger(customers) || customers < 1 || customers > 1000) {
    throw new Error("LOAD_CUSTOMERS must be a whole number from 1 to 1000");
  }
  return customers;
}

/** Business i's number in three digits, as the k6 script works it out too. */
export const pad = (i: number) => String(i).padStart(3, "0");

/**
 * Where business i's call texts and emails go. Fictional (CLAUDE.md): Ofcom's drama range for
 * the mobile, example.com for the email. The worker allowlists exactly these, so the texts and
 * emails go through the whole send path to the fakes, and nothing else could.
 */
export const loadMobile = (i: number) => `+447700900${pad(i)}`;
export const loadNotifyEmail = (i: number) => `notify${pad(i)}@example.com`;

/**
 * How long a text may take to reach the tradesperson after the call ends (BUILD_PLAN Step 6's
 * 60 seconds): the runner fails the load test if any takes longer. LOAD_TEXT_SECONDS overrides.
 */
export const LOAD_TEXT_DEADLINE_SECONDS = Number(process.env.LOAD_TEXT_SECONDS ?? "60");
