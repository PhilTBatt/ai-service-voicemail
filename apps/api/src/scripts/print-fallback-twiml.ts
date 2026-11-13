// Prints the fallback voicemail as two TwiML Bins for Phil to paste into the Twilio Console.
//   npm run twiml:fallback                      bin 1: the "thanks, goodbye" (create this first)
//   npm run twiml:fallback -- --done-url <url>  bin 2: the greeting, pointing at bin 1's URL
// The greeting carries the API's recording callback: PUBLIC_BASE_URL from .env (the laptop's
// ngrok address), or --base-url <the API's address> for production's bin (RUNBOOK section 16).
import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { fallbackVoicemailBins } from "../core/twiml.ts";

const { values } = parseArgs({
  options: { "done-url": { type: "string" }, "base-url": { type: "string" } },
});
const config = loadConfig(process.env);
const baseUrl = (values["base-url"] ?? config.publicBaseUrl)?.replace(/\/+$/, "");

if (values["done-url"] === undefined) {
  console.error("Bin 1 of 2. Paste this into a new TwiML Bin named 'AnswerMate voicemail done',");
  console.error("then run again with --done-url <that bin's URL> for bin 2.\n");
  console.log(fallbackVoicemailBins.done());
} else if (!/^https:\/\/\S+$/.test(values["done-url"])) {
  // Bin 1's ID alone (EH...) printed a bin that only worked if Twilio read it relative to
  // bin 2's own address (2026-11-13): ask for the whole URL instead.
  console.error(
    `--done-url should be bin 1's whole URL, starting https:// (the URL box on its page in the Twilio console), not "${values["done-url"]}".`,
  );
  process.exitCode = 1;
} else if (!baseUrl) {
  console.error(
    "PUBLIC_BASE_URL is missing from .env and no --base-url was given; bin 2 needs the API's callback URL.",
  );
  process.exitCode = 1;
} else if (!/^https:\/\/[^/\s]+$/.test(baseUrl)) {
  // Twilio has to reach it from the internet, so https and a host name only.
  console.error(`The API's address should be just https:// and its host name, not "${baseUrl}".`);
  process.exitCode = 1;
} else {
  console.error(
    "Bin 2 of 2. Paste this into the TwiML Bin named 'AnswerMate fallback voicemail' (or a new one).",
  );
  console.error("Its URL is the number's fallback URL (FALLBACK_VOICEMAIL_URL).\n");
  console.log(
    fallbackVoicemailBins.greeting(values["done-url"], `${baseUrl}/webhooks/twilio/recording`),
  );
}
