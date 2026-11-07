import { ClerkProvider } from "@clerk/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App.tsx";
import "./styles.css";

// Public by design: it only identifies our Clerk application. vite.config.ts lets this one
// variable through from the root .env; the secret key never reaches the browser.
const publishableKey = import.meta.env.CLERK_PUBLISHABLE_KEY;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {publishableKey ? (
      <ClerkProvider publishableKey={publishableKey} afterSignOutUrl="/">
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ClerkProvider>
    ) : (
      <main className="page">
        <h1>AnswerMate</h1>
        <p>CLERK_PUBLISHABLE_KEY isn't set in the .env file at the root of the repo.</p>
      </main>
    )}
  </StrictMode>,
);
