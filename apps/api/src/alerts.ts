import { logger } from "./logger.ts";

/**
 * Something a person needs to see soon. For now it's an error-level log line carrying an
 * `alert` field; Step 8 routes those lines to Phil's phone. Details go through the
 * redacting logger like everything else, so never put call content in them.
 */
export function raiseAlert(alert: string, details: Record<string, unknown> = {}): void {
  logger.error(`ALERT ${alert}`, { alert, ...details });
}

export type AlertFn = typeof raiseAlert;
