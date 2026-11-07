// The dashboard's dev server and build. Docs: https://vite.dev/config/
//
// Settings come from the .env at the repo root, shared with the API. Vite only hands the
// browser code variables whose names start with an allowed prefix, so CLERK_PUBLISHABLE_KEY
// (public by design) gets through and CLERK_SECRET_KEY and every other secret never do.
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig(({ mode }) => {
  // Read here only for the proxy target; nothing in `env` reaches the browser.
  const env = loadEnv(mode, repoRoot, "PORT");
  return {
    plugins: [react()],
    envDir: repoRoot,
    envPrefix: ["VITE_", "CLERK_PUBLISHABLE_"],
    server: {
      port: 5173,
      // Login tokens are tied to this address (DASHBOARD_ORIGIN), so never drift to 5174.
      strictPort: true,
      // The browser calls /api on the dev server, which passes it to the API. One site, so no
      // cross-origin setup is needed.
      proxy: { "/api": `http://localhost:${env.PORT ?? "3000"}` },
    },
  };
});
