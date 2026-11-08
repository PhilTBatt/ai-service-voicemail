// The synthetic-call checker (BUILD_PLAN Step 14). Each night a few real calls go to a test
// business on staging, each playing a recording: a gas emergency, a routine job, and silence.
// This decides, from what the database shows, whether each came out as it should: the call
// stored and processed, its urgency right, and the right texts and emails sent within a
// minute of it ending, with nothing sent that shouldn't be.
//
// Placing the calls (a Twilio outbound call that plays the recording) and running them nightly
// come with staging (Step 8) and Phil's budget. This part needs neither, so it's built and
// tested now. db/synthetic-calls.ts reads what it judges.
import type { Urgency } from "@callmate/shared";
import type { NotificationChannel, NotificationStatus } from "../jobs/deliver-notification.ts";

export type SyntheticScenarioName = "gas" | "routine" | "silence";

export interface SyntheticScenario {
  /** What the recording says, for the report. */
  description: string;
  /** The urgencies the extraction may give it. */
  urgency: readonly Urgency[];
  /** Messages that must go out. Email only where the test business has an address. */
  required: readonly NotificationChannel[];
  /** Messages that mustn't exist: an emergency text about a dripping tap wakes someone for nothing. */
  forbidden: readonly NotificationChannel[];
}

export const SYNTHETIC_SCENARIOS: Record<SyntheticScenarioName, SyntheticScenario> = {
  gas: {
    description: "A caller who can smell gas",
    urgency: ["emergency"],
    // The tradesperson's emergency text, the gas advice text to the caller, then the summaries.
    required: ["sms_emergency", "sms_caller", "sms", "email"],
    forbidden: [],
  },
  routine: {
    description: "A caller wanting a quote to replace a dripping tap",
    urgency: ["routine", "urgent"],
    required: ["sms", "email"],
    forbidden: ["sms_emergency", "sms_caller"],
  },
  silence: {
    description: "A caller who says nothing",
    // Anything but an emergency: what matters is that the call is still recorded and told.
    urgency: ["routine", "urgent", "spam", "other"],
    required: ["sms", "email"],
    forbidden: ["sms_emergency", "sms_caller"],
  },
};

/** What the database shows for one synthetic call so far. */
export interface ObservedCall {
  /** Null until the call is stored. Urgency is null until it's processed, or if that failed. */
  call: { endedAt: Date | null; urgency: Urgency | null; processed: boolean } | null;
  notifications: readonly {
    channel: NotificationChannel;
    status: NotificationStatus;
    /**
     * When its current status was recorded: when it was sent, or when the delivery receipt came.
     * A message that went on a retry counts from when it finally went.
     */
    statusAt: Date;
  }[];
}

export interface SyntheticCheckOptions {
  /** When the call was placed. */
  placedAt: Date;
  now: Date;
  /** How long the call may take to be stored and to end: it runs a minute or two itself. */
  callDeadlineSeconds: number;
  /** How soon after the call ends each message must go (the Step 6 target: 60 seconds). */
  notifyWithinSeconds: number;
  /** Whether the test business has an email address, so an email is expected. */
  expectEmail: boolean;
}

export type SyntheticCheck =
  /** Every message went; the slowest left this many seconds after the call ended. */
  | { result: "passed"; slowestSeconds: number }
  | { result: "waiting"; for: string[] }
  | { result: "failed"; problems: string[] };

const LABELS: Record<NotificationChannel, string> = {
  sms: "summary text",
  email: "summary email",
  sms_emergency: "emergency text to the tradesperson",
  sms_caller: "gas advice text to the caller",
};

const secondsBetween = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / 1000);

/** Judges one synthetic call as it stands. "waiting" only ever lasts until a deadline passes. */
export function evaluateSyntheticCall(
  name: SyntheticScenarioName,
  observed: ObservedCall,
  options: SyntheticCheckOptions,
): SyntheticCheck {
  const scenario = SYNTHETIC_SCENARIOS[name];
  const { call, notifications } = observed;
  if (!call?.endedAt) {
    const sincePlaced = secondsBetween(options.placedAt, options.now);
    if (sincePlaced > options.callDeadlineSeconds) {
      return {
        result: "failed",
        problems: [
          call
            ? `The call hadn't ended ${sincePlaced} s after it was placed`
            : `No call stored ${sincePlaced} s after it was placed`,
        ],
      };
    }
    return { result: "waiting", for: [call ? "the call to end" : "the call to be stored"] };
  }

  const { endedAt } = call;
  const limit = options.notifyWithinSeconds;
  // Past the window, anything still missing is a failure rather than something to wait for.
  const late = secondsBetween(endedAt, options.now) > limit;
  const problems: string[] = [];
  const waitingFor: string[] = [];

  for (const channel of scenario.forbidden) {
    if (notifications.some((message) => message.channel === channel)) {
      problems.push(`The ${LABELS[channel]} went out, and shouldn't have`);
    }
  }

  if (!call.processed) {
    if (late) problems.push(`The call wasn't processed within ${limit} s of ending`);
    else waitingFor.push("the call to be processed");
  } else if (call.urgency === null || !scenario.urgency.includes(call.urgency)) {
    problems.push(
      `The call's urgency is ${call.urgency ?? "missing"}, not ${scenario.urgency.join(" or ")}`,
    );
  }

  let slowestSeconds = 0;
  for (const channel of scenario.required) {
    if (channel === "email" && !options.expectEmail) continue;
    const message = notifications.find((candidate) => candidate.channel === channel);
    if (message && (message.status === "sent" || message.status === "delivered")) {
      // An emergency text can go mid-call, before the call ends: that counts as 0.
      const after = Math.max(0, secondsBetween(endedAt, message.statusAt));
      if (after > limit) {
        problems.push(
          `The ${LABELS[channel]} went ${after} s after the call ended (limit ${limit} s)`,
        );
      }
      slowestSeconds = Math.max(slowestSeconds, after);
    } else if (message && (message.status === "blocked" || message.status === "undelivered")) {
      // Final: the allowlist stopped it, or the carrier couldn't deliver it.
      problems.push(`The ${LABELS[channel]} was ${message.status}`);
    } else if (late) {
      // Not there, still pending, or failed and being retried: out of time either way.
      problems.push(
        message?.status === "failed"
          ? `The ${LABELS[channel]} failed and hadn't gone ${limit} s after the call ended`
          : `No ${LABELS[channel]} within ${limit} s of the call ending`,
      );
    } else {
      waitingFor.push(`the ${LABELS[channel]}`);
    }
  }

  if (problems.length > 0) return { result: "failed", problems };
  if (waitingFor.length > 0) return { result: "waiting", for: waitingFor };
  return { result: "passed", slowestSeconds };
}

/** Looks at the call every `pollSeconds` until it passes or fails. */
export async function waitForSyntheticCall(
  name: SyntheticScenarioName,
  observe: () => Promise<ObservedCall>,
  options: Omit<SyntheticCheckOptions, "now"> & {
    pollSeconds?: number;
    now?: () => Date;
    sleep?: (milliseconds: number) => Promise<void>;
  },
): Promise<Exclude<SyntheticCheck, { result: "waiting" }>> {
  const now = options.now ?? (() => new Date());
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, milliseconds);
      }));
  for (;;) {
    const check = evaluateSyntheticCall(name, await observe(), { ...options, now: now() });
    if (check.result !== "waiting") return check;
    await sleep((options.pollSeconds ?? 5) * 1000);
  }
}
