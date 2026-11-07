// The browser smoke tests (BUILD_PLAN Step 10): a real browser drives the real dashboard
// against the real API and the test database. Only the sign-in itself is a stand-in (see
// src/testing/clerk-stub.tsx). Docs: https://playwright.dev/docs/test-configuration
//
// Run from the repo root, with the test database up (npm run db:up): npm run e2e
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

// The repo root: the test database setup finds the migrations from there.
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const webDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  // One shared database, seeded once: the tests run in order, one at a time.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:5174",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node apps/api/src/testing/e2e-server.ts",
      cwd: repoRoot,
      url: "http://localhost:3100/healthz",
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "npx vite --mode e2e",
      cwd: webDir,
      url: "http://localhost:5174",
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
