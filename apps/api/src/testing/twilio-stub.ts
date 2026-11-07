// A stand-in for Twilio's REST API: the number endpoints the adapter uses, with Twilio's
// JSON shapes and status codes, recording what it was sent.

interface Captured {
  method: string;
  path: string;
  query: Record<string, string>;
  form: Record<string, string>;
}

export class TwilioApiStub {
  readonly numbers = new Map<string, { phone_number: string; form: Record<string, string> }>();
  readonly requests: Captured[] = [];
  /** Tests fill these in, in Twilio's JSON shapes. */
  readonly recordings: Record<string, unknown>[] = [];
  readonly calls = new Map<string, Record<string, unknown>>();
  readonly deletedRecordingSids = new Set<string>();
  /** Recording audio by SID, for the .mp3 media endpoint. */
  readonly recordingAudio = new Map<string, Uint8Array<ArrayBuffer>>();
  private nextSid = 1;

  readonly fetch: typeof fetch = (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? "GET";
    const form = Object.fromEntries(
      new URLSearchParams(typeof init?.body === "string" ? init.body : ""),
    );
    this.requests.push({
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      form,
    });
    return Promise.resolve(this.handle(method, url.pathname, form));
  };

  private handle(method: string, path: string, form: Record<string, string>): Response {
    const json = (status: number, data: unknown) => Response.json(data, { status });
    const tail = path.replace(/^\/2010-04-01\/Accounts\/[^/]+/, "");

    if (method === "GET" && tail === "/Recordings.json") {
      return json(200, { recordings: this.recordings });
    }
    const mediaMatch = /^\/Recordings\/([^/]+)\.mp3$/.exec(tail);
    if (method === "GET" && mediaMatch) {
      const bytes = this.recordingAudio.get(decodeURIComponent(mediaMatch[1]!));
      return bytes
        ? new Response(bytes, { status: 200, headers: { "content-type": "audio/mpeg" } })
        : json(404, { code: 20404, message: "not found" });
    }
    const recMatch = /^\/Recordings\/([^/]+)\.json$/.exec(tail);
    if (method === "DELETE" && recMatch) {
      const sid = decodeURIComponent(recMatch[1]!);
      if (this.deletedRecordingSids.has(sid))
        return json(404, { code: 20404, message: "not found" });
      this.deletedRecordingSids.add(sid);
      return new Response(null, { status: 204 });
    }
    const callMatch = /^\/Calls\/([^/]+)\.json$/.exec(tail);
    if (method === "GET" && callMatch) {
      const call = this.calls.get(decodeURIComponent(callMatch[1]!));
      return call ? json(200, call) : json(404, { code: 20404, message: "not found" });
    }
    if (method === "GET" && tail === "/AvailablePhoneNumbers/GB/Local.json") {
      return json(200, {
        available_phone_numbers: [
          { phone_number: "+441134960100", locality: "Leeds", region: "West Yorkshire" },
          { phone_number: "+441134960101", locality: "Leeds", region: "West Yorkshire" },
        ],
      });
    }
    if (method === "POST" && tail === "/IncomingPhoneNumbers.json") {
      const sid = `PNstub${String(this.nextSid++).padStart(4, "0")}`;
      this.numbers.set(sid, { phone_number: form.PhoneNumber ?? "", form });
      return json(201, { sid, phone_number: form.PhoneNumber });
    }
    const match = /^\/IncomingPhoneNumbers\/([^/]+)\.json$/.exec(tail);
    if (match) {
      const sid = decodeURIComponent(match[1]!);
      const owned = this.numbers.get(sid);
      if (!owned)
        return json(404, { code: 20404, message: "The requested resource was not found" });
      if (method === "POST") {
        owned.form = { ...owned.form, ...form };
        return json(200, { sid, phone_number: owned.phone_number });
      }
      if (method === "DELETE") {
        this.numbers.delete(sid);
        return new Response(null, { status: 204 });
      }
    }
    return json(404, { message: `stub has no route for ${method} ${path}` });
  }
}
