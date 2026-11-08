// Every setting the API and the worker can use, filled with stand-ins, for the tests that check
// what each one switches on (worker-jobs.test.ts, server-app.test.ts). Nothing is ever sent with
// them: those tests only build the app and the job list, and never let a job run.
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from "./databases.ts";

export const STAND_IN_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: TEST_DATABASE_URL,
  ADMIN_DATABASE_URL: TEST_ADMIN_DATABASE_URL,
  RETELL_API_KEY: "key_for_tests",
  TWILIO_ACCOUNT_SID: "AC" + "a".repeat(32),
  TWILIO_AUTH_TOKEN: "token_for_tests",
  PUBLIC_BASE_URL: "https://callmate.example.com",
  FALLBACK_VOICEMAIL_URL: "https://handler.twilio.com/twiml/EH0",
  ANTHROPIC_API_KEY: "key_for_tests",
  TWILIO_SMS_FROM: "AnswerMate",
  SIGNING_SECRET: "x".repeat(32),
  POSTMARK_SERVER_TOKEN: "token_for_tests",
  POSTMARK_WEBHOOK_SECRET: "y".repeat(16),
  EMAIL_FROM: "calls@example.com",
  CLERK_SECRET_KEY: "sk_test_for_tests",
} as const;

/** Just enough for the worker to start: the database and Retell. */
export const MINIMAL_WORKER_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: TEST_DATABASE_URL,
  RETELL_API_KEY: "key_for_tests",
} as const;
