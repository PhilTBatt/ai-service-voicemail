import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Migrates the test database once, before any test runs.
    globalSetup: ["apps/api/src/testing/global-setup.ts"],
  },
});
