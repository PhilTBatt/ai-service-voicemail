// Phone setup (BUILD_PLAN Step 11): how the tradesperson sends the calls they miss to their
// AnswerMate number, for their network (Appendix C), how to check it worked, and how to test
// it. The instructions come from packages/shared/src/divert.ts, the same as the text.
import {
  MOBILE_NETWORKS,
  MOBILE_NETWORK_KEYS,
  DIVERT_TURN_OFF_CODES,
  divertInstructions,
  voicemailRestoreCode,
  type MeView,
  type MobileNetwork,
  type TenantView,
} from "@callmate/shared";
import { useState } from "react";
import { useParams } from "react-router";
import { useApi, useLoad } from "../api.ts";
import { formatPhone } from "../format.ts";
import { TenantHeader } from "../tenant-header.tsx";
import { ErrorNote } from "../ui.tsx";

export function PhonePage({ me }: { me: MeView }) {
  const { tenantId = "" } = useParams();
  const { api } = useApi();
  const tenant = useLoad(() => api<TenantView>(`/tenants/${tenantId}`), tenantId);

  if (tenant.status === "loading") return <p className="muted">Loading…</p>;
  if (tenant.status === "error") return <ErrorNote error={tenant.error} retry={tenant.reload} />;
  return (
    <>
      <TenantHeader me={me} tenant={tenant.data} />
      <Instructions key={tenant.data.id} tenant={tenant.data} />
    </>
  );
}

function Instructions({ tenant }: { tenant: TenantView }) {
  const [network, setNetwork] = useState<MobileNetwork | "">(tenant.mobileNetwork ?? "");
  // A business that has left needs the way back, number or not: once the number is released
  // the page used to say it "isn't ready yet", while the Cancelled card sends people here.
  if (tenant.status === "cancelling" || tenant.status === "cancelled") {
    const restore = voicemailRestoreCode(tenant.mobileNetwork);
    return (
      <section className="card">
        <h2>Turn off your diverts</h2>
        <p>
          On your own mobile, dial each of these and press call, as if ringing a number:{" "}
          {DIVERT_TURN_OFF_CODES.map((code, index) => (
            <span key={code}>
              {index > 0 && ", "}
              <code>{code}</code>
            </span>
          ))}
          . They turn off the diverts for calls you don't answer, calls when you're busy, and calls
          when your phone is off.
        </p>
        <p>
          {restore ? (
            <>
              Then dial <code>{restore}</code> to get your network's voicemail back.
            </>
          ) : (
            "Then ring your network if you'd like your voicemail back: they'll tell you the code."
          )}
        </p>
      </section>
    );
  }
  if (!tenant.number) {
    return (
      <section className="card">
        <h2>Phone setup</h2>
        <p>Your AnswerMate number isn't ready yet. These steps appear here once it is.</p>
      </section>
    );
  }
  const steps = divertInstructions(network === "" ? null : network, tenant.number);

  return (
    <>
      <section className="card">
        <h2>Send the calls you miss to AnswerMate</h2>
        <p>
          Your AnswerMate number is <strong>{formatPhone(tenant.number)}</strong>. On your own
          mobile, dial each code below and press call, as if ringing a number. Your phone shows a
          message saying whether it worked.
        </p>
        <label className="stacked">
          Your mobile network
          <select
            value={network}
            onChange={(event) => setNetwork(event.target.value as MobileNetwork | "")}
          >
            <option value="">I'm not sure</option>
            {MOBILE_NETWORK_KEYS.map((key) => (
              <option key={key} value={key}>
                {MOBILE_NETWORKS[key]}
              </option>
            ))}
          </select>
        </label>
        <div className="table-wrap">
          <table className="usage codes">
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
                  <td>{code.when}</td>
                  <td>
                    <code>{code.turnOn}</code>
                  </td>
                  <td>
                    <code>{code.check}</code>
                  </td>
                  <td>
                    <code>{code.turnOff}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul>
          {steps.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>Check it, then test it</h2>
        <ol>
          <li>
            Dial <code>*#61#</code> and press call. Your phone should say the divert is active, with
            your AnswerMate number.
          </li>
          <li>
            Ring your mobile from another phone and don't answer. After the rings you'll hear a
            short message and a beep: say a few words, then hang up. That's your test call: it tells
            us your divert works.
          </li>
        </ol>
      </section>

      <section className="card">
        <h2>If you ever leave AnswerMate</h2>
        <p>
          Turning these diverts off leaves you with no voicemail at all, because they replaced your
          network's.{" "}
          {steps.restoreVoicemail ? (
            <>
              To get your network's voicemail back, dial <code>{steps.restoreVoicemail}</code>.
            </>
          ) : (
            <>Ask your network how to turn its voicemail back on.</>
          )}
        </p>
      </section>
    </>
  );
}
