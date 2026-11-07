// The settings Vite hands to the browser code (see envPrefix in vite.config.ts).
declare global {
  interface ImportMetaEnv {
    readonly CLERK_PUBLISHABLE_KEY?: string;
  }
}

export {};
