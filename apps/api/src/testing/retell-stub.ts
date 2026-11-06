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
    return Promise.resolve(this.handle(method, decodeURIComponent(url.pathname), body));
  };

  private handle(
    method: string,
    path: string,
    body: Record<string, unknown> | undefined,
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
    if (method === "DELETE" && first === "v2" && second === "delete-call" && segments[2]) {
      if (this.deletedCalls.has(segments[2])) return json(404, { message: "call not found" });
      this.deletedCalls.add(segments[2]);
      return new Response(null, { status: 204 });
    }
    return json(404, { message: `stub has no route for ${method} ${path}` });
  }
}
