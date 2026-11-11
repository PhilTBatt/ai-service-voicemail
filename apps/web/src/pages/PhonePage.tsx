// Phone setup (BUILD_PLAN Step 11): how the tradesperson sends the calls they miss to their
// AnswerMate number, for their network (Appendix C), how to check it worked, and how to test
// it. The instructions come from packages/shared/src/divert.ts, the same as the text.
import {
  MOBILE_NETWORKS,
  MOBILE_NETWORK_KEYS,
  DIVERT_TURN_OFF_CODES,
  divertInstructions,
  voicemailRestoreCode,
  type MobileNetwork,
  type TenantView,
} from "@callmate/shared";
import { useState } from "react";
import {
  Alert,
  Card,
  CopyCode,
  EmptyState,
  SectionHeader,
  SelectField,
} from "../design/components.tsx";
import { Hourglass, PhoneForwarded, ListChecks, Undo2 } from "../design/icons.ts";
import { formatPhone } from "../format.ts";
import { useTenant } from "../tenant-layout.tsx";

export function PhonePage() {
  const { tenant } = useTenant();
  return (
    <div className="stack stack-lg">
      <SectionHeader
        title="Phone setup"
        description="Send the calls you can't answer to AnswerMate, using codes you dial on your own mobile."
      />
      <Instructions key={tenant.id} tenant={tenant} />
    </div>
  );
}

function Instructions({ tenant }: { tenant: TenantView }) {
  const [network, setNetwork] = useState<MobileNetwork | "">(tenant.mobileNetwork ?? "");
  // A business that has left needs the way back, number or not: once the number is released
  // the page used to say it "isn't ready yet", while the Cancelled card sends people here.
  if (tenant.status === "cancelling" || tenant.status === "cancelled") {
    const restore = voicemailRestoreCode(tenant.mobileNetwork);
    return (
      <Card icon={Undo2} title="Turn off your diverts">
        <p>
          On your own mobile, dial each of these and press call, as if ringing a number. They turn
          off the diverts for calls you don't answer, calls when you're busy, and calls when your
          phone is off.
        </p>
        <div className="cluster">
          {DIVERT_TURN_OFF_CODES.map((code) => (
            <CopyCode key={code} code={code} />
          ))}
        </div>
        {restore ? (
          <p>
            Then dial <CopyCode code={restore} /> to get your network's voicemail back.
          </p>
        ) : (
          <p>
            Then ring your network if you'd like your voicemail back: they'll tell you the code.
          </p>
        )}
      </Card>
    );
  }
  if (!tenant.number) {
    return (
      <div className="card">
        <EmptyState icon={Hourglass} title="Your AnswerMate number isn't ready yet">
          These steps appear here once it is.
        </EmptyState>
      </div>
    );
  }
  const steps = divertInstructions(network === "" ? null : network, tenant.number);

  return (
    <>
      <Card
        icon={PhoneForwarded}
        title="Send the calls you miss to AnswerMate"
        description="Dial each code below on your own mobile and press call, as if ringing a number. Your phone shows a message saying whether it worked."
      >
        <div className="stack stack-xs">
          <span className="muted text-sm">Your AnswerMate number</span>
          <span className="big-number">{formatPhone(tenant.number)}</span>
        </div>
        <SelectField
          label="Your mobile network"
          value={network}
          onChange={(event) => setNetwork(event.target.value as MobileNetwork | "")}
        >
          <option value="">I'm not sure</option>
          {MOBILE_NETWORK_KEYS.map((key) => (
            <option key={key} value={key}>
              {MOBILE_NETWORKS[key]}
            </option>
          ))}
        </SelectField>
        <div className="table-wrap">
          <table className="table table-stack">
            <thead>
              <tr>
                <th>Divert calls…</th>
                <th>Dial to turn on</th>
                <th>Check it</th>
                <th>Turn off</th>
              </tr>
            </thead>
            <tbody>
              {steps.codes.map((code) => (
                <tr key={code.check}>
                  <td data-label="">
                    <strong>{code.when}</strong>
                  </td>
                  <td data-label="Turn on">
                    <CopyCode code={code.turnOn} />
                  </td>
                  <td data-label="Check">
                    <CopyCode code={code.check} />
                  </td>
                  <td data-label="Turn off">
                    <CopyCode code={code.turnOff} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {steps.notes.length > 0 && (
          <Alert tone="info">
            <ul className="stack stack-xs">
              {steps.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </Alert>
        )}
      </Card>

      <Card icon={ListChecks} title="Check it, then test it">
        <ol className="steps">
          <li className="step">
            <span className="step-marker" />
            <div className="step-body">
              <p className="step-title">Check the divert is on</p>
              <p className="muted text-sm">
                Dial <CopyCode code="*#61#" /> and press call. Your phone should say the divert is
                active, with your AnswerMate number.
              </p>
            </div>
          </li>
          <li className="step">
            <span className="step-marker" />
            <div className="step-body">
              <p className="step-title">Make a test call</p>
              <p className="muted text-sm">
                Ring your mobile from another phone and don't answer. After the rings you'll hear a
                short message and a beep: say a few words, then hang up. That tells us your divert
                works.
              </p>
            </div>
          </li>
        </ol>
      </Card>

      <Card icon={Undo2} title="If you ever leave AnswerMate">
        <p>
          Turning these diverts off leaves you with no voicemail at all, because they replaced your
          network's.{" "}
          {steps.restoreVoicemail ? (
            <>
              To get your network's voicemail back, dial <CopyCode code={steps.restoreVoicemail} />.
            </>
          ) : (
            <>Ask your network how to turn its voicemail back on.</>
          )}
        </p>
      </Card>
    </>
  );
}
