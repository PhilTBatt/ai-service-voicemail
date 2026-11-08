/* global __ENV */
// The load test (BUILD_PLAN Step 14, decision 013). `npm run load` starts the load-test API,
// with fakes for every outside service, and runs this in k6's Docker image against it.
//
// The traffic is MULTIPLIER (10) times the expected busy hour, worked out as Appendix F does:
// CUSTOMERS (100) businesses at 0.024 Erlangs each, with calls of CALL_MINUTES (2) on average.
// Three scenarios run at once:
// - calls: calls arriving at that rate, each sending us the webhooks a real call sends;
// - spike: as many calls starting in the same moment as the busy hour needs lines, times 10;
// - dashboard: tradespeople opening their calls, twice an hour each, times 10.
import { check, fail } from "k6";
import crypto from "k6/crypto";
import encoding from "k6/encoding";
import http from "k6/http";

const API = __ENV.API_URL || "http://localhost:3200";
const PUBLIC = __ENV.PUBLIC_BASE_URL || "https://load.callmate.test";
const CUSTOMERS = Number(__ENV.LOAD_CUSTOMERS || 100);
const MULTIPLIER = Number(__ENV.LOAD_MULTIPLIER || 10);
const CALL_MINUTES = Number(__ENV.LOAD_CALL_MINUTES || 2);
const DURATION = __ENV.LOAD_DURATION || "2m";
/** The fakes' fixed test key (providers/*.fake.ts): not a secret. */
const SIGNING_KEY = "not-a-real-key";
const ACCOUNT_SID = "AC" + "0".repeat(32);

// Appendix F: the busy-hour traffic A in Erlangs, and the lines it needs at 0.1% blocking,
// about A + 3√A (100 businesses: 2.4 Erlangs, about 7 lines).
const erlangs = CUSTOMERS * 0.024;
const lines = Math.round(erlangs + 3 * Math.sqrt(erlangs));
const callsPerMinute = Math.ceil((erlangs / CALL_MINUTES) * MULTIPLIER);
const spikeCalls = lines * MULTIPLIER;
const dashboardPerMinute = Math.ceil(((CUSTOMERS * 2) / 60) * MULTIPLIER);

export const options = {
  scenarios: {
    calls: {
      executor: "constant-arrival-rate",
      exec: "call",
      rate: callsPerMinute,
      timeUnit: "1m",
      duration: DURATION,
      preAllocatedVUs: 5,
      maxVUs: 50,
    },
    spike: {
      executor: "per-vu-iterations",
      exec: "call",
      vus: spikeCalls,
      iterations: 1,
      startTime: "30s",
      maxDuration: "1m",
    },
    dashboard: {
      executor: "constant-arrival-rate",
      exec: "dashboard",
      rate: dashboardPerMinute,
      timeUnit: "1m",
      duration: DURATION,
      preAllocatedVUs: 5,
      maxVUs: 50,
    },
  },
  // Each one is also the report: the summary prints the p95 against every threshold.
  thresholds: {
    http_req_failed: ["rate<0.01"],
    checks: ["rate>0.99"],
    // Steady traffic. The caller is ringing while we answer the voice webhook: it decides
    // what they hear.
    "http_req_duration{scenario:calls,name:twilio-voice}": ["p(95)<500"],
    "http_req_duration{scenario:calls,name:call-ended}": ["p(95)<1000"],
    "http_req_duration{scenario:calls,name:dial-status}": ["p(95)<500"],
    "http_req_duration{scenario:calls,name:sms-status}": ["p(95)<500"],
    // The burst: every call in it waits its turn for a database connection. Twilio waits
    // 15 seconds for an answer before giving up on us.
    "http_req_duration{scenario:spike,name:twilio-voice}": ["p(95)<3000"],
    "http_req_duration{scenario:spike,name:call-ended}": ["p(95)<3000"],
    "http_req_duration{name:dashboard-me}": ["p(95)<800"],
    "http_req_duration{name:dashboard-calls}": ["p(95)<800"],
    "http_req_duration{name:dashboard-call}": ["p(95)<800"],
  },
  summaryTrendStats: ["avg", "med", "p(95)", "p(99)", "max", "count"],
};

const pad = (i) => String(i).padStart(3, "0");
const pick = (count) => Math.floor(Math.random() * count);
const hex = (length) => Array.from({ length }, () => "0123456789abcdef"[pick(16)]).join("");
const tokenFor = (i) =>
  encoding.b64encode(
    JSON.stringify({ subject: `sub_load_${pad(i)}`, email: `owner${pad(i)}@example.com` }),
  );

/** Logs every owner in once (which claims their invitation) and finds their business and a call. */
export function setup() {
  const owners = [];
  for (let i = 0; i < CUSTOMERS; i++) {
    const params = { headers: { authorization: `Bearer ${tokenFor(i)}` }, tags: { name: "setup" } };
    const me = http.get(`${API}/api/me`, params);
    if (me.status !== 200) fail(`Owner ${i} couldn't sign in: HTTP ${me.status}`);
    const tenantId = http.get(`${API}/api/tenants`, params).json("tenants.0.id");
    const callId = http.get(`${API}/api/tenants/${tenantId}/calls`, params).json("calls.0.callId");
    owners.push({ token: tokenFor(i), tenantId, callId });
  }
  return { owners };
}

/** A Twilio webhook, signed as Twilio signs: the public URL plus the sorted form fields. */
function twilio(path, fields, name) {
  const signed =
    PUBLIC +
    path +
    Object.keys(fields)
      .sort()
      .map((key) => key + fields[key])
      .join("");
  return http.post(`${API}${path}`, fields, {
    headers: { "x-twilio-signature": crypto.hmac("sha1", SIGNING_KEY, signed, "base64") },
    tags: { name },
  });
}

/** One call, as it reaches us: Twilio asks where to send it, the platform says it ended, the
 *  agent leg's status comes back, and the summary text's two delivery receipts arrive. */
export function call() {
  const business = pick(CUSTOMERS);
  const to = `+441632960${pad(business)}`;
  const from = `+447700900${pad(500 + pick(500))}`;
  const callSid = `CA${hex(32)}`;

  const routed = twilio(
    "/webhooks/twilio/voice",
    { AccountSid: ACCOUNT_SID, CallSid: callSid, From: from, To: to, CallStatus: "ringing" },
    "twilio-voice",
  );
  check(routed, {
    "the call goes to the agent": (r) => r.status === 200 && r.body.includes("<Sip>"),
  });

  const now = Date.now();
  const body = JSON.stringify({
    event: "call_ended",
    call: {
      providerCallId: `call_${hex(24)}`,
      providerAgentId: `agent_load_${pad(business)}`,
      dialledNumber: to,
      callerNumber: from,
      startedAt: new Date(now - CALL_MINUTES * 60_000).toISOString(),
      endedAt: new Date(now).toISOString(),
      durationSeconds: CALL_MINUTES * 60,
      endReason: "user_hangup",
      transcript: [
        { role: "agent", text: "Hello, you're through to Load Test Plumbing." },
        { role: "caller", text: "My tap is dripping in the kitchen." },
      ],
      recordingRef: null,
      costs: [],
    },
  });
  const ended = http.post(`${API}/webhooks/voice/fake`, body, {
    headers: {
      "content-type": "application/json",
      "x-fake-signature": crypto.hmac("sha256", SIGNING_KEY, body, "hex"),
    },
    tags: { name: "call-ended" },
  });
  check(ended, { "the call is stored": (r) => r.status === 204 });

  const dialled = twilio(
    "/webhooks/twilio/dial-status",
    { AccountSid: ACCOUNT_SID, CallSid: callSid, DialCallStatus: "completed" },
    "dial-status",
  );
  check(dialled, { "the call ends cleanly": (r) => r.status === 200 });

  const messageSid = `SM${hex(32)}`;
  for (const status of ["sent", "delivered"]) {
    const receipt = twilio(
      "/webhooks/twilio/sms-status",
      { AccountSid: ACCOUNT_SID, MessageSid: messageSid, MessageStatus: status },
      "sms-status",
    );
    check(receipt, { "the receipt is taken": (r) => r.status >= 200 && r.status < 300 });
  }
}

/** A tradesperson opening the dashboard: who am I, my calls, one call. */
export function dashboard(data) {
  const owner = data.owners[pick(data.owners.length)];
  const headers = { authorization: `Bearer ${owner.token}` };
  const base = `${API}/api/tenants/${owner.tenantId}`;
  const me = http.get(`${API}/api/me`, { headers, tags: { name: "dashboard-me" } });
  const calls = http.get(`${base}/calls`, { headers, tags: { name: "dashboard-calls" } });
  const one = http.get(`${base}/calls/${owner.callId}`, {
    headers,
    tags: { name: "dashboard-call" },
  });
  check(me, { "signed in": (r) => r.status === 200 });
  check(calls, { "calls listed": (r) => r.status === 200 });
  check(one, { "call shown": (r) => r.status === 200 });
}
