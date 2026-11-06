// Prints the fallback voicemail as a TwiML Bin for Phil to paste into the Twilio Console.
// Run from the repo root: npm run twiml:fallback
// Needs PUBLIC_BASE_URL in .env, because the bin carries the API's recording callback URL.
import { loadConfig } from "../config.ts";
import { fallbackVoicemailBin } from "../core/twiml.ts";

const config = loadConfig(process.env);
if (!config.publicBaseUrl) {
  console.error("PUBLIC_BASE_URL is missing from .env; the bin needs the API's callback URL.");
  process.exitCode = 1;
} else {
  console.error("Paste everything below into a TwiML Bin (Twilio Console > TwiML Bins), then set");
  console.error("the bin's URL as the number's fallback URL (FALLBACK_VOICEMAIL_URL).\n");
  console.log(fallbackVoicemailBin(`${config.publicBaseUrl}/webhooks/twilio/recording`));
}
