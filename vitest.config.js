import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Migrates the test database once, before any test runs.
    globalSetup: ["apps/api/src/testing/global-setup.ts"],
    // Silences the app logger while tests run; TEST_LOGS=1 shows it again.
    setupFiles: ["apps/api/src/testing/quiet-logs.ts"],
    // npm run coverage: which lines and branches the tests reach. The HTML report goes to
    // coverage/ (git ignores it); the summary prints at the end.
    coverage: {
      provider: "v8",
      include: ["apps/api/src/**/*.ts", "packages/shared/src/**/*.ts"],
      exclude: ["**/*.test.ts", "apps/api/src/testing/**", "apps/api/src/scripts/**"],
      reporter: ["text-summary", "html"],
    },
  },
});
