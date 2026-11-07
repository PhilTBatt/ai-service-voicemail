// A stand-in for Retell's HTTP API, so the adapter's request logic runs offline. It
// implements just the endpoints the adapter uses, with Retell's status codes, and keeps
// what it was sent so tests can inspect the exact bodies.

interface Captured {
  method: string;
  path: string;
  body: unknown;
}

export class RetellApiStub {
  readonly flows = new Map<string, unknown>();
  readonly agents = new Map<string, { flowId: string; body: unknown }>();
  readonly calls: Record<string, unknown>[] = [];
  readonly deletedCalls = new Set<string>();
  /** Get Call responses by call ID, and recording audio by URL; tests fill these in. */
  readonly callRecords = new Map<string, Record<string, unknown>>();
  /** Test case definitions by ID, batch jobs, and the runs every batch returns; tests fill these in. */
  readonly testCases = new Map<string, Record<string, unknown> & { name: string }>();
  readonly batches = new Map<string, { polls: number }>();
  readonly testRuns: Record<string, unknown>[] = [];
  /** How many get-batch-test polls before a batch reports complete. */
  batchPollsUntilComplete = 1;
  testRunsPageSize = 50;
  readonly recordingAudio = new Map<string, Uint8Array<ArrayBuffer>>();
  readonly requests: Captured[] = [];
  private nextId = 1;

  readonly fetch: typeof fetch = (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    this.requests.push({ method, path: url.pathname, body });
    if (url.origin !== "https://api.retellai.com") {
      // A recording URL (Retell's storage, not its API): serve the bytes if we have them.
      const bytes = this.recordingAudio.get(url.href);
      return Promise.resolve(
        bytes
          ? new Response(bytes, { status: 200, headers: { "content-type": "audio/wav" } })
          : new Response("not found", { status: 404 }),
      );
    }
    return Promise.resolve(
      this.handle(method, decodeURIComponent(url.pathname), body, url.searchParams),
    );
  };

  private handle(
    method: string,
    path: string,
    body: Record<string, unknown> | undefined,
    query: URLSearchParams,
  ): Response {
    const json = (status: number, data: unknown) => Response.json(data, { status });
    const segments = path.split("/").filter(Boolean);
    const [first, second] = segments;

    if (method === "POST" && first === "create-conversation-flow") {
      const id = `conversation_flow_stub${this.nextId++}`;
      this.flows.set(id, body);
      return json(201, { conversation_flow_id: id, version: 0 });
    }
    if (method === "POST" && first === "create-agent") {
      const flowId = (body?.response_engine as { conversation_flow_id?: string } | undefined)
        ?.conversation_flow_id;
      if (!flowId || !this.flows.has(flowId))
        return json(400, { message: "unknown conversation flow" });
      const id = `agent_stub${this.nextId++}`;
      this.agents.set(id, { flowId, body });
      return json(201, { agent_id: id });
    }
    if (method === "GET" && first === "get-agent" && second) {
      const agent = this.agents.get(second);
      return agent
        ? json(200, {
            agent_id: second,
            response_engine: { type: "conversation-flow", conversation_flow_id: agent.flowId },
          })
        : json(404, { message: "agent not found" });
    }
    if (method === "PATCH" && first === "update-conversation-flow" && second) {
      if (!this.flows.has(second)) return json(404, { message: "flow not found" });
      this.flows.set(second, body);
      return json(200, { conversation_flow_id: second, version: 1 });
    }
    if (method === "PATCH" && first === "update-agent" && second) {
      const agent = this.agents.get(second);
      if (!agent) return json(404, { message: "agent not found" });
      agent.body = { ...(agent.body as object), ...body };
      return json(200, { agent_id: second });
    }
    if (method === "POST" && first === "v2" && second === "register-phone-call") {
      const agentId = body?.agent_id;
      if (typeof agentId !== "string" || !this.agents.has(agentId)) {
        return json(404, { message: "agent not found" });
      }
      this.calls.push(body ?? {});
      return json(201, { call_id: `call_stub${this.calls.length}`, call_status: "registered" });
    }
    if (method === "POST" && first === "create-test-case-definition") {
      const id = `tcd_stub${this.nextId++}`;
      const record = { ...(body ?? {}), name: String(body?.name), test_case_definition_id: id };
      this.testCases.set(id, record);
      return json(201, record);
    }
    if (method === "GET" && first === "v2" && second === "list-test-case-definitions") {
      const flowId = query.get("conversation_flow_id");
      const items = [...this.testCases.values()].filter(
        (d) =>
          (d.response_engine as { conversation_flow_id?: string } | undefined)
            ?.conversation_flow_id === flowId,
      );
      return json(200, { items, has_more: false });
    }
    if (method === "DELETE" && first === "delete-test-case-definition" && second) {
      if (!this.testCases.delete(second)) return json(404, { message: "not found" });
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && first === "create-batch-test") {
      const id = `batch_stub${this.nextId++}`;
      this.batches.set(id, { polls: 0 });
      return json(201, this.batchJson(id));
    }
    if (method === "GET" && first === "get-batch-test" && second) {
      const batch = this.batches.get(second);
      if (!batch) return json(404, { message: "batch not found" });
      batch.polls += 1;
      return json(200, this.batchJson(second));
    }
    if (method === "GET" && first === "v2" && second === "list-test-runs" && segments[2]) {
      const offset = Number(query.get("pagination_key") ?? "0");
      const items = this.testRuns.slice(offset, offset + this.testRunsPageSize);
      const next = offset + this.testRunsPageSize;
      return json(200, {
        items: items.map((run) => ({
          test_case_definition_snapshot: { name: "", user_prompt: "", metrics: [] },
          ...run,
        })),
        has_more: next < this.testRuns.length,
        ...(next < this.testRuns.length && { pagination_key: String(next) }),
      });
    }
    if (method === "GET" && first === "v2" && second === "get-call" && segments[2]) {
      const call = this.callRecords.get(segments[2]);
      return call && !this.deletedCalls.has(segments[2])
        ? json(200, call)
        : json(404, { message: "call not found" });
    }
    if (method === "DELETE" && first === "v2" && second === "delete-call" && segments[2]) {
      if (this.deletedCalls.has(segments[2])) return json(404, { message: "call not found" });
      this.deletedCalls.add(segments[2]);
      return new Response(null, { status: 204 });
    }
    return json(404, { message: `stub has no route for ${method} ${path}` });
  }

  private batchJson(id: string) {
    const batch = this.batches.get(id)!;
    const complete = batch.polls >= this.batchPollsUntilComplete;
    return {
      test_case_batch_job_id: id,
      status: complete ? "complete" : "in_progress",
      pass_count: complete ? this.testRuns.filter((r) => r.status === "pass").length : 0,
      fail_count: complete ? this.testRuns.filter((r) => r.status === "fail").length : 0,
      error_count: complete ? this.testRuns.filter((r) => r.status === "error").length : 0,
      total_count: this.testRuns.length,
    };
  }
}
