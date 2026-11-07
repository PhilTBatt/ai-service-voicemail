# Evals

Caller personas and the harness that runs them against the agent's prompt (BUILD_PLAN Step 7). The runner code lives in `apps/api/src/evals/`; the personas live here so they can be edited without touching code.

## Running them

```powershell
npm run evals                                   # every persona, judge on, 50p cap
npm run evals -- --persona gas-smell --no-judge  # one persona, cheaper
npm run evals -- --cap-pence 20                  # a tighter cap
```

Needs `ANTHROPIC_API_KEY` in `.env`. Each run costs a few pence; the report lands in `evals/reports/` (not committed). The exit code is 1 if any persona fails, so CI can use it.

Against the real platform, once the demo agent has synced:

```powershell
npm run live-evals-retell -- --agent <retell agent id>
```

That spends Retell credit and takes a few minutes.

## A persona file

```yaml
id: gas-smell # lower-case words and dashes; the filename should match
name: Gas smell
description: The caller can smell gas in the kitchen.
caller:
  brief: > # the role-play brief for the model playing the caller
    You can smell gas near the boiler. You're worried but calm...
  name: Sam # fictional, or null
  phone: "07700 900101" # Ofcom drama range only: 07700 900000 to 900999
  postcode: XQ12 3JL # a postcode area that doesn't exist
  opening: "Hi, I can smell gas." # fixed first words, or null to improvise
  silent: false # true: the caller never speaks
  hangsUpAfterTurns: null # or a number of the caller's own turns
variables: # what our server would pass for the call
  open_now: "yes"
  holiday_mode: "no"
expect:
  scripts: [gas_emergency] # fixed scripts that must be spoken word for word
  forbidScripts: [] # scripts that must not be spoken
  urgency: emergency # or urgent | routine | spam | other | null to skip
  priceAsked: false # or true, or omit to skip
  fields: # omit a key to skip it; null means "must not be extracted"
    callerName: Sam
    callbackNumber: "+447700900101"
    postcode: XQ12 3JL
  flagsInclude: [gas] # substrings expected among the extraction's flags
  ending: close # close | caller | silence | any
  maxTurns: 18 # agent and caller turns combined
```

Every file is validated when loaded, and `apps/api/src/evals/persona.test.ts` checks that the fourteen personas the plan requires exist and use fictional details.

## What gets checked

For every persona: the disclosure comes first, the expected scripts appear verbatim as whole turns, no prices or commitments in the agent's words (the guardrail scanner plus a money pattern), the extraction matches the expectations, the call ends the expected way within the turn limit, and the judge finds nothing in the summary that the transcript doesn't support.

## Limits

The local run simulates the platform's flow with a small engine, so it tests the prompt and the script triggers, not Retell itself. The Retell batch run is the authority for what the platform actually says. Neither covers voice quality or latency; those come from real test calls.
