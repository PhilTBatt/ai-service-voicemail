// Prints the fallback voicemail as two TwiML Bins for Phil to paste into the Twilio Console.
//   npm run twiml:fallback                      bin 1: the "thanks, goodbye" (create this first)
//   npm run twiml:fallback -- --done-url <url>  bin 2: the greeting, pointing at bin 1's URL
// The greeting carries the API's recording callback, so PUBLIC_BASE_URL must be in .env.
import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { fallbackVoicemailBins } from "../core/twiml.ts";

const { values } = parseArgs({ options: { "done-url": { type: "string" } } });
const config = loadConfig(process.env);

if (values["done-url"] === undefined) {
  console.error("Bin 1 of 2. Paste this into a new TwiML Bin named 'AnswerMate voicemail done',");
  console.error("then run again with --done-url <that bin's URL> for bin 2.\n");
  console.log(fallbackVoicemailBins.done());
} else if (!config.publicBaseUrl) {
  console.error("PUBLIC_BASE_URL is missing from .env; bin 2 needs the API's callback URL.");
  process.exitCode = 1;
} else {
  console.error(
    "Bin 2 of 2. Paste this into a new TwiML Bin named 'AnswerMate fallback voicemail'.",
  );
  console.error("Its URL is the number's fallback URL (FALLBACK_VOICEMAIL_URL).\n");
  console.log(
    fallbackVoicemailBins.greeting(
      values["done-url"],
      `${config.publicBaseUrl}/webhooks/twilio/recording`,
    ),
  );
}
