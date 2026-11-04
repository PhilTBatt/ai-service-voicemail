// Placeholder entry point. Replaced by the Express app later in Step 0.
import { ConfigError, loadConfig } from "./config.ts";

try {
  const config = loadConfig(process.env);
  console.log(`CallMate API skeleton: config OK (${config.nodeEnv}, port ${config.port})`);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(error.message);
  process.exitCode = 1;
}
