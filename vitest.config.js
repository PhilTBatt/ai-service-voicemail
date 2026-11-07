import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Migrates the test database once, before any test runs.
    globalSetup: ["apps/api/src/testing/global-setup.ts"],
    // Silences the app logger while tests run; TEST_LOGS=1 shows it again.
    setupFiles: ["apps/api/src/testing/quiet-logs.ts"],
  },
});
