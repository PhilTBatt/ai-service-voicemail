// The dashboard's dev server and build. Docs: https://vite.dev/config/
//
// Settings come from the .env at the repo root, shared with the API. Vite only hands the
// browser code variables whose names start with an allowed prefix, so CLERK_PUBLISHABLE_KEY
// (public by design) gets through and CLERK_SECRET_KEY and every other secret never do.
//
// `vite --mode e2e` is the browser smoke tests' dashboard (playwright.config.ts): Clerk is
// swapped for a stand-in, and /api goes to the smoke-test API on port 3100 instead.
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export const E2E_WEB_PORT = 5174;
const E2E_API_PORT = 3100; // apps/api/src/testing/e2e-server.ts

export default defineConfig(({ mode }) => {
  const e2e = mode === "e2e";
  // Read here only for the proxy target; nothing in `env` reaches the browser.
  const env = loadEnv(mode, repoRoot, "PORT");
  return {
    plugins: [react()],
    envDir: repoRoot,
    envPrefix: ["VITE_", "CLERK_PUBLISHABLE_"],
    ...(e2e && {
      resolve: {
        alias: {
          "@clerk/react": fileURLToPath(new URL("./src/testing/clerk-stub.tsx", import.meta.url)),
        },
      },
      // The stand-in needs no key; the app only checks that one is set.
      define: { "import.meta.env.CLERK_PUBLISHABLE_KEY": JSON.stringify("pk_test_e2e") },
    }),
    server: {
      port: e2e ? E2E_WEB_PORT : 5173,
      // Login tokens are tied to this address (DASHBOARD_ORIGIN), so never drift to 5174.
      strictPort: true,
      // The browser calls /api on the dev server, which passes it to the API. One site, so no
      // cross-origin setup is needed.
      proxy: {
        "/api": e2e ? `http://localhost:${E2E_API_PORT}` : `http://localhost:${env.PORT ?? "3000"}`,
      },
    },
  };
});
