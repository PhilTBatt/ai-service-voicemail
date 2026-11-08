# 015: When a safety message is spoken, and when again

- **Date:** 2026-11-08
- **Status:** accepted 2026-11-08 (Claude, after Phil's yes to an eval run, revised after a subagent review the same day; Phil can change any of it)
- **Code:** `apps/api/src/core/prompt-builder.ts` (the triggers, `closeWhen`), `apps/api/src/core/agent.ts` (`oncePerCall`), `apps/api/src/providers/retell.ts` (`cool_down`), `apps/api/src/evals/simulate.ts` and `assertions.ts` (the same rules in the simulation, and the checks)

## 1. The problem

CLAUDE.md says to over-trigger on purpose, and Appendix B says a false alarm costs nothing. The eval runs showed what a false alarm can cost when it repeats:

- **2026-11-07:** a caller said "nobody's hurt, no fire, I've switched it off at the wall". The 999 message played six times in that call, and the caller's number and postcode were never taken.
- **2026-11-08:** the water message ("turn off your water at the stopcock") played three times to a caller who had said they couldn't find their stopcock.

The triggers were written as states, such as "the caller mentions sparks". Retell checks a global node's condition "against the conversation" after each thing the caller says ([global node guide](https://docs.retellai.com/build/conversation-flow/global-node), [transition conditions](https://docs.retellai.com/build/conversation-flow/transition-condition)). A state stays true for the rest of the call, so the condition kept matching. Retell's `cool_down` stops a node firing "again within the next N node transitions" ([API reference](https://docs.retellai.com/api-references/create-conversation-flow)). Ours was 1, which only covers the turn straight after the message.

## 2. The rules now

Each trigger is keyed on its message, not on the mention. It fires while the hazard has been mentioned and the message hasn't been spoken yet.

My first wording, "the first time in the call the caller mentions…", had a hole the review found. If the platform passed over that first mention, nothing later was ever "the first time", so the message would never play. That could happen while the flow is still on the opening node, or when a second hazard comes in the same breath and the other message plays first.

| Message   | When                                                                                                                                                                                     | Platform guard                                 |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Gas or CO | Mentioned (a smell, a leak, carbon monoxide, an alarm), even in passing, and not spoken yet. Again, once, if played down or the smell or alarm gets worse. If in doubt, trigger.         | `cool_down: 1`                                 |
| 999       | Sparks, burning, smoke, fire, a shock, live wires, a collapse or danger to a person mentioned, and not spoken yet. Again, once, if something new or worse happens. If in doubt, trigger. | `cool_down: 1`                                 |
| Water     | Water that can't be stopped mentioned, and not spoken yet                                                                                                                                | Once a call (`oncePerCall`, `cool_down: 1000`) |

The gas and 999 messages aren't repeated when the caller is only repeating themselves or answering questions.

What `cool_down: 1` does in our flow is my reading of the docs, not something I've seen. The caller's reply straight after a message moves the flow on rather than playing the message again, so a dismissal at that point gets the agent's acknowledgement ("noted, and Ant will be told"). The message can play again on the caller's words after that.

The evals fail a call where a message plays more than twice (the water message, more than once), or where the agent leaves a caller's turn unanswered.

The close condition matters here too. The platform moves to the goodbye as soon as it holds. So "the caller wants to go" only counts once the agent has asked once for anything still missing; otherwise a hurried caller in an emergency could leave without giving a number or postcode.

## 3. Options considered

| Option                                                                                  | Why not                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Keyed on the message, once more if played down or worse (chosen)**                    | (chosen)                                                                                                                                                                                                                                                                                    |
| "The first time it's mentioned"                                                         | A first mention the platform passes over is never "the first time" again, so the message could never play                                                                                                                                                                                   |
| Keep the state triggers, and raise `cool_down` for every message                        | Our flow stays on the take-message node between scripts, so few transitions happen and a high `cool_down` means once a call. That ends the second play for a played-down gas warning, which is deliberate: `buildScripts` re-plays it "instead of leaving the model to argue or paraphrase" |
| Once a call for every message                                                           | The same loss, and a caller whose "faint smell" becomes "it's really strong now" should hear the gas message again                                                                                                                                                                          |
| Leave it, since over-triggering is the rule                                             | The eval runs show the cost: the details that let the tradesperson ring back weren't taken, and callers got angry                                                                                                                                                                           |
| Retell's negative fine-tune examples on each global node (`negative_finetune_examples`) | In the API schema, but no flow of ours has used them yet. A shape mistake would stop every agent syncing. Worth trying once the live contract test runs                                                                                                                                     |

## 4. Confidence and the case against

- **Medium.** The wording is tested in the local simulation, where the engine applies the same once-a-call and cool-down rules. Retell's own model judges the real conditions, and only the live batch run (`npm run live-evals-retell`) shows whether it reads them the same way.
- **Unverified:** how Retell counts transitions for `cool_down`, both for 1 (section 2) and for 1000 as "once a call".
- **The strongest case against:** a caller who mentions gas, and then says something about it that's new but not clearly worse, hears the message once, not twice. The gas message still plays, the call is still an emergency (`core/spoken-scripts.ts` and the extraction's rules), and the tradesperson is alerted mid-call. A missed repeat costs less than a loop that stops the message being taken.
