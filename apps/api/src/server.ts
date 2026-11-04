// Placeholder entry point. Replaced by the Express app later in Step 0.
import { ConfigError, loadConfig } from "./config.ts";
import { logger } from "./logger.ts";

try {
  const config = loadConfig(process.env);
  logger.level = config.logLevel;
  logger.info("Config loaded", { nodeEnv: config.nodeEnv, port: config.port });
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  logger.error("Invalid environment configuration", { problems: error.problems });
  process.exitCode = 1;
}
