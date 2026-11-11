import { ClerkProvider } from "@clerk/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App.tsx";
import { ConfirmProvider } from "./design/dialog.tsx";
import { ToastProvider } from "./design/toast.tsx";
// The design system, in this order: tokens first, then what's built from them (docs/UI.md).
import "./design/tokens.css";
import "./design/base.css";
import "./design/components.css";
import "./design/shell.css";
import "./design/patterns.css";
import "./design/legacy.css";

// Public by design: it only identifies our Clerk application. vite.config.ts lets this one
// variable through from the root .env; the secret key never reaches the browser.
const publishableKey = import.meta.env.CLERK_PUBLISHABLE_KEY;

/**
 * Clerk's sign-in box and account menu in our colours. Each value is one of our tokens, so they
 * follow light and dark mode with the rest of the page. Docs:
 * https://clerk.com/docs/react/guides/customizing-clerk/appearance-prop/variables
 */
const clerkAppearance = {
  variables: {
    colorPrimary: "var(--color-brand-solid)",
    colorPrimaryForeground: "var(--color-on-brand)",
    colorBackground: "var(--color-surface)",
    colorForeground: "var(--color-text)",
    colorMutedForeground: "var(--color-text-muted)",
    colorInput: "var(--color-surface)",
    colorInputForeground: "var(--color-text)",
    colorBorder: "var(--color-border-strong)",
    colorDanger: "var(--color-danger-solid)",
    colorSuccess: "var(--color-success-solid)",
    colorWarning: "var(--color-warning-solid)",
    fontFamily: "var(--font-sans)",
    borderRadius: "10px",
  },
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {publishableKey ? (
      <ClerkProvider
        publishableKey={publishableKey}
        afterSignOutUrl="/"
        appearance={clerkAppearance}
      >
        <BrowserRouter>
          <ToastProvider>
            <ConfirmProvider>
              <App />
            </ConfirmProvider>
          </ToastProvider>
        </BrowserRouter>
      </ClerkProvider>
    ) : (
      <main className="content">
        <h1>AnswerMate</h1>
        <p>CLERK_PUBLISHABLE_KEY isn't set in the .env file at the root of the repo.</p>
      </main>
    )}
  </StrictMode>,
);
