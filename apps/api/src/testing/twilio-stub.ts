// A stand-in for Twilio's REST API: the number endpoints the adapter uses, with Twilio's
// JSON shapes and status codes, recording what it was sent.

interface Captured {
  method: string;
  path: string;
  query: Record<string, string>;
  form: Record<string, string>;
  /** A JSON body (the Batch Transcription API), when the request had one. */
  json?: unknown;
}

/** A transcription configuration as voice.twilio.com lists it (the fields the adapter reads). */
interface StubTranscriptionConfiguration {
  id: string;
  unique_name: string;
  configuration: Record<string, unknown>;
}

export class TwilioApiStub {
  /** The Batch Transcription API's configurations and the transcriptions asked for (decision 022). */
  readonly transcriptionConfigurations: StubTranscriptionConfiguration[] = [];
  readonly transcriptions: { id: string; body: Record<string, unknown> }[] = [];
  /** The field the configurations list comes under; Twilio's reference doesn't say, so tests vary it. */
  configurationsListKey = "configurations";
  readonly numbers = new Map<string, { phone_number: string; form: Record<string, string> }>();
  readonly requests: Captured[] = [];
  /** Tests fill these in, in Twilio's JSON shapes. */
  readonly recordings: Record<string, unknown>[] = [];
  readonly calls = new Map<string, Record<string, unknown>>();
  readonly deletedRecordingSids = new Set<string>();
  /**
   * Call records in Twilio's JSON shape (start_time in RFC 2822, as Twilio sends it). GET
   * /Calls.json filters them, DELETE removes them.
   */
  readonly callRecords: {
    sid: string;
    to: string;
    start_time: string;
    parent_call_sid: string | null;
  }[] = [];
  /** Recordings per page from GET /Recordings.json, with Twilio-style next_page_uri. */
  recordingsPageSize = 100;
  /** Recording audio by SID, for the .mp3 media endpoint. */
  readonly recordingAudio = new Map<string, Uint8Array<ArrayBuffer>>();
  private nextSid = 1;

  readonly fetch: typeof fetch = (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const isJson = headers.get("content-type")?.includes("application/json") ?? false;
    const form = Object.fromEntries(
      new URLSearchParams(!isJson && typeof init?.body === "string" ? init.body : ""),
    );
    const json =
      isJson && typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    this.requests.push({
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      form,
      ...(json !== undefined && { json }),
    });
    if (url.hostname === "voice.twilio.com") {
      return Promise.resolve(this.handleVoiceApi(method, url.pathname, json));
    }
    if (url.hostname === "pricing.twilio.com") {
      return Promise.resolve(
        Response.json({
          country: "United Kingdom",
          iso_country: "GB",
          price_unit: "GBP",
          phone_number_prices: [
            { number_type: "local", base_price: "0.86917", current_price: "0.86917" },
            { number_type: "mobile", base_price: "1.8895", current_price: "1.8895" },
            { number_type: "toll free", base_price: "2.04066", current_price: "2.04066" },
            { number_type: "something new", base_price: "9", current_price: "9" },
          ],
        }),
      );
    }
    return Promise.resolve(this.handle(method, url.pathname, form, url.searchParams));
  };

  /** voice.twilio.com: the transcription configurations and the transcriptions (JSON in and out). */
  private handleVoiceApi(method: string, path: string, body: unknown): Response {
    const json = (status: number, data: unknown) => Response.json(data, { status });
    const asRecord = (body ?? {}) as Record<string, unknown>;
    if (path === "/v2/Configurations/Transcription") {
      if (method === "GET") {
        return json(200, {
          [this.configurationsListKey]: this.transcriptionConfigurations,
          meta: { nextToken: null },
        });
      }
      if (method === "POST") {
        const created = {
          id: `voice_transcriptionconfiguration_stub${this.transcriptionConfigurations.length + 1}`,
          unique_name: typeof asRecord.unique_name === "string" ? asRecord.unique_name : "",
          configuration: (asRecord.configuration ?? {}) as Record<string, unknown>,
        };
        this.transcriptionConfigurations.push(created);
        return json(201, created);
      }
    }
    const configurationMatch = /^\/v2\/Configurations\/Transcription\/([^/]+)$/.exec(path);
    if (method === "PUT" && configurationMatch) {
      const existing = this.transcriptionConfigurations.find(
        (configuration) => configuration.id === decodeURIComponent(configurationMatch[1]!),
      );
      if (!existing) return json(404, { message: "not found" });
      existing.configuration = (asRecord.configuration ?? {}) as Record<string, unknown>;
      return json(200, existing);
    }
    if (method === "POST" && path === "/v3/Transcriptions") {
      if (
        !this.transcriptionConfigurations.some(
          (configuration) => configuration.id === asRecord.transcriptionConfigurationId,
        )
      ) {
        return json(400, { code: 20001, message: "unknown transcriptionConfigurationId" });
      }
      const id = `voice_transcription_stub${this.transcriptions.length + 1}`;
      this.transcriptions.push({ id, body: asRecord });
      return json(201, {
        status: "PENDING",
        statusUrl: `https://voice.twilio.com/v3/Transcriptions/${id}`,
        transcription: { id, status: "PENDING", sourceId: asRecord.sourceId },
      });
    }
    return json(404, { message: `stub has no route for ${method} ${path}` });
  }

  private handle(
    method: string,
    path: string,
    form: Record<string, string>,
    query: URLSearchParams,
  ): Response {
    const json = (status: number, data: unknown) => Response.json(data, { status });
    const tail = path.replace(/^\/2010-04-01\/Accounts\/[^/]+/, "");

    if (method === "GET" && tail === "/Recordings.json") {
      const offset = Number(query.get("PageToken") ?? "0");
      const next = offset + this.recordingsPageSize;
      return json(200, {
        recordings: this.recordings.slice(offset, next),
        next_page_uri:
          next < this.recordings.length
            ? `/2010-04-01/Accounts/AC0/Recordings.json?PageToken=${next}&PageSize=${this.recordingsPageSize}`
            : null,
      });
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
    if (method === "GET" && tail === "/Calls.json") {
      const to = query.get("To");
      const after = query.get("StartTime>"); // a UTC date: on or after it
      const parent = query.get("ParentCallSid");
      const calls = this.callRecords.filter(
        (call) =>
          (to === null || call.to === to) &&
          (after === null || new Date(call.start_time).toISOString().slice(0, 10) >= after) &&
          (parent === null || call.parent_call_sid === parent),
      );
      return json(200, {
        calls: calls.map((call) => ({ sid: call.sid, start_time: call.start_time })),
        next_page_uri: null,
      });
    }
    const callMatch = /^\/Calls\/([^/]+)\.json$/.exec(tail);
    if (method === "DELETE" && callMatch) {
      const sid = decodeURIComponent(callMatch[1]!);
      const index = this.callRecords.findIndex((call) => call.sid === sid);
      if (index === -1) return json(404, { code: 20404, message: "not found" });
      this.callRecords.splice(index, 1);
      return new Response(null, { status: 204 });
    }
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
