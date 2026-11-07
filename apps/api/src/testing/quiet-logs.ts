// Runs before every test file (vitest.config.js). The code under test logs as it works, and
// printed, those lines bury the test results. Tests that check logging build their own
// logger (logger.test.ts), so silencing the shared one hides nothing they look at.
// To see the lines while debugging, in PowerShell: $env:TEST_LOGS = "1"; npm test
import { logger } from "../logger.ts";

if (process.env.TEST_LOGS !== "1") logger.silent = true;
