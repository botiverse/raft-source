import assert from "node:assert/strict";
import { ManagedMcpGatewayError } from "./managedMcpGateway";
import { probeManagedMcpEndpoint, probeManagedMcpEndpointWithCatalog } from "./managedMcpProbe";

const ENDPOINT = "https://probe.example.test/mcp";
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

/** A fake network: the MCP endpoint answers `endpoint`; other URLs come from `documents` or 404. */
function stubFetch(endpoint: (body: { method?: string; id?: number }) => Response, documents: Record<string, unknown> = {}): typeof fetch {
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
    if (url === ENDPOINT) {
      if ((init?.method ?? "GET") !== "POST") return new Response(null, { status: 405 });
      return endpoint(JSON.parse(String(init?.body)) as { method?: string; id?: number });
    }
    return url in documents ? json(documents[url]) : new Response("not found", { status: 404 });
  }) as typeof fetch;
}

/** A minimal Streamable HTTP MCP server answering with plain JSON. */
const mcpServer = (body: { method?: string; id?: number }) => {
  if (body.id === undefined) return new Response(null, { status: 202 });
  if (body.method === "initialize") {
    return json({ jsonrpc: "2.0", id: body.id, result: {
      protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "Stub", version: "1.2.3" },
    } });
  }
  if (body.method === "tools/list") {
    return json({ jsonrpc: "2.0", id: body.id, result: { tools: [
      { name: "search", inputSchema: { type: "object" } },
      { name: "write", inputSchema: { type: "object" } },
    ] } });
  }
  return json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "not found" } });
};

const unauthorized = (headers: Record<string, string> = {}) => () =>
  new Response("unauthorized", { status: 401, headers });

const AS = "https://auth.example.test";
const asMetadata = (extra: Record<string, unknown>) => ({
  issuer: AS,
  authorization_endpoint: `${AS}/authorize`,
  token_endpoint: `${AS}/token`,
  response_types_supported: ["code"],
  ...extra,
});

test("⭐ probe: a server that answers without credentials is ready, with its tools and server info", async () => {
  const result = await probeManagedMcpEndpoint(ENDPOINT, { fetch: stubFetch(mcpServer) });
  assert.equal(result.outcome, "ready");
  assert.deepEqual(result.tools, { count: 2, names: ["search", "write"] });
  assert.deepEqual(result.serverInfo, { protocolVersion: "2025-06-18", name: "Stub", version: "1.2.3" });
  assert.equal(typeof result.latencyMs, "number");
});

const PRM = "https://probe.example.test/.well-known/oauth-protected-resource/mcp";
const AS_METADATA = `${AS}/.well-known/oauth-authorization-server`;

test("⭐ probe: a server that lists tools without a token but publishes OAuth metadata for itself needs sign-in (Google Workspace MCP)", async () => {
  const { result, toolCatalog } = await probeManagedMcpEndpointWithCatalog(ENDPOINT, { fetch: stubFetch(mcpServer, {
    [PRM]: { resource: ENDPOINT, authorization_servers: [AS], scopes_supported: ["mail.read"] },
    [AS_METADATA]: asMetadata({}),
  }) });
  assert.equal(result.outcome, "oauth");
  assert.deepEqual(result.oauth, { issuer: AS, registration: "manual_required", scopes: ["mail.read"] });
  assert.deepEqual(result.tools, { count: 2, names: ["search", "write"] }, "the tokenless tools are kept for a no-sign-in choice");
  assert.deepEqual(toolCatalog?.map((tool) => tool.name), ["search", "write"]);
});

test("probe: the metadata request is the one sign-in sends (a server that requires MCP-Protocol-Version still counts)", async () => {
  const base = stubFetch(mcpServer, {
    [PRM]: { resource: ENDPOINT, authorization_servers: [AS] },
    [AS_METADATA]: asMetadata({}),
  });
  const strict = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
    if (url === PRM && !new Headers(init?.headers).get("MCP-Protocol-Version")) return new Response("missing version", { status: 404 });
    return base(input, init);
  }) as typeof fetch;
  const result = await probeManagedMcpEndpoint(ENDPOINT, { fetch: strict });
  assert.equal(result.outcome, "oauth");
});

test("probe: an authorization server the network policy refuses is reported as a refusal, not saved as no sign-in", async () => {
  const base = stubFetch(mcpServer, { [PRM]: { resource: ENDPOINT, authorization_servers: [AS] } });
  const refusing = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
    if (url.startsWith(AS)) throw new ManagedMcpGatewayError("blocked by policy", "managed_mcp_endpoint_blocked");
    return base(input, init);
  }) as typeof fetch;
  const { result, toolCatalog } = await probeManagedMcpEndpointWithCatalog(ENDPOINT, { fetch: refusing });
  assert.equal(result.outcome, "unreachable");
  assert.equal(result.error?.code, "managed_mcp_endpoint_blocked");
  assert.equal(toolCatalog, null);
});

test("probe: metadata that does not make sign-in possible for this endpoint leaves a tokenless server ready", async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["no authorization server", { [PRM]: { resource: ENDPOINT, authorization_servers: [] } }],
    ["metadata for another resource", { [PRM]: { resource: "https://elsewhere.example.test/mcp", authorization_servers: [AS] }, [AS_METADATA]: asMetadata({}) }],
    ["a sibling path's resource", { [PRM]: { resource: "https://probe.example.test/other", authorization_servers: [AS] }, [AS_METADATA]: asMetadata({}) }],
    ["an authorization server with no metadata (404)", { [PRM]: { resource: ENDPOINT, authorization_servers: [AS] } }],
    ["malformed metadata", { [PRM]: { authorization_servers: "not-a-list" } }],
  ];
  for (const [label, documents] of cases) {
    const result = await probeManagedMcpEndpoint(ENDPOINT, { fetch: stubFetch(mcpServer, documents) });
    assert.equal(result.outcome, "ready", label);
  }
  // A complete answer with no body (204) is "no metadata", not a broken read.
  const noContent = (match: string, documents: Record<string, unknown>) => {
    const base = stubFetch(mcpServer, documents);
    return (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
      return url.startsWith(match) ? new Response(null, { status: 204 }) : base(input, init);
    }) as typeof fetch;
  };
  const prm204 = await probeManagedMcpEndpoint(ENDPOINT, { fetch: noContent("https://probe.example.test/.well-known/", {}) });
  assert.equal(prm204.outcome, "ready", "protected-resource metadata answered 204");
  const as204 = await probeManagedMcpEndpoint(ENDPOINT, { fetch: noContent(AS, { [PRM]: { resource: ENDPOINT, authorization_servers: [AS] } }) });
  assert.equal(as204.outcome, "ready", "authorization-server metadata answered 204");
});

/** A 200 whose body stream errors after the headers arrived. */
const brokenBody = () => new Response(new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode("{\"resource\":"));
    controller.error(new TypeError("terminated"));
  },
}), { status: 200, headers: { "Content-Type": "application/json" } });

test("⭐ probe: a sign-in check that did not finish is unreachable, never saved as no sign-in", async () => {
  const base = stubFetch(mcpServer, { [PRM]: { resource: ENDPOINT, authorization_servers: [AS] } });
  const failing = (match: string, fail: () => Promise<Response>) => (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
    return url.startsWith(match) ? fail() : base(input, init);
  }) as typeof fetch;
  const cases: Array<[string, typeof fetch]> = [
    ["metadata 503", failing(PRM, async () => new Response("busy", { status: 503 }))],
    ["metadata network error", failing(PRM, async () => { throw new TypeError("fetch failed"); })],
    ["authorization server network error", failing(AS, async () => { throw new TypeError("fetch failed"); })],
    ["authorization server 502", failing(AS, async () => new Response("bad gateway", { status: 502 }))],
    ["metadata body cut off mid-read", failing(PRM, async () => brokenBody())],
    ["authorization server body cut off mid-read", failing(AS, async () => brokenBody())],
  ];
  for (const [label, fetchFn] of cases) {
    const { result, toolCatalog } = await probeManagedMcpEndpointWithCatalog(ENDPOINT, { fetch: fetchFn });
    assert.equal(result.outcome, "unreachable", label);
    assert.equal(result.error?.code, "managed_mcp_unreachable", label);
    assert.equal(toolCatalog, null, label);
  }
  const slow = failing(AS, () => new Promise<Response>((resolve) => setTimeout(() => resolve(json(asMetadata({}))), 500)));
  const { result: timedOut } = await probeManagedMcpEndpointWithCatalog(ENDPOINT, { fetch: slow, timeoutMs: 100 });
  assert.equal(timedOut.outcome, "unreachable", "the probe deadline during the sign-in check");
});

test("⭐ probe: a 401 is classified by how Raft could register (DCR, CIMD, or manual)", async () => {
  const prm = `https://probe.example.test/.well-known/oauth-protected-resource/mcp`;
  const withPrm = (metadata: Record<string, unknown>) => stubFetch(
    unauthorized({ "WWW-Authenticate": `Bearer resource_metadata="${prm}"` }),
    {
      [prm]: { resource: ENDPOINT, authorization_servers: [AS], scopes_supported: ["read", "write"] },
      [`${AS}/.well-known/oauth-authorization-server`]: asMetadata(metadata),
    },
  );
  const dcr = await probeManagedMcpEndpoint(ENDPOINT, { fetch: withPrm({ registration_endpoint: `${AS}/register` }) });
  assert.equal(dcr.outcome, "oauth");
  assert.deepEqual(dcr.oauth, { issuer: AS, registration: "dcr", scopes: ["read", "write"] });
  const cimd = await probeManagedMcpEndpoint(ENDPOINT, { fetch: withPrm({ client_id_metadata_document_supported: true }) });
  assert.equal(cimd.oauth?.registration, "cimd");
  const manual = await probeManagedMcpEndpoint(ENDPOINT, { fetch: withPrm({}) });
  assert.equal(manual.outcome, "oauth");
  assert.equal(manual.oauth?.registration, "manual_required");
});

test("probe: a 401 with no OAuth metadata anywhere, or a 403, asks for API-key headers", async () => {
  const bare = await probeManagedMcpEndpoint(ENDPOINT, { fetch: stubFetch(unauthorized()) });
  assert.equal(bare.outcome, "headers");
  assert.deepEqual(bare.suggestedHeaderNames, ["Authorization"]);
  const forbidden = await probeManagedMcpEndpoint(ENDPOINT, { fetch: stubFetch(() => new Response("forbidden", { status: 403 })) });
  assert.equal(forbidden.outcome, "headers");
});

test("⭐ probe: a 5xx or a network failure is unreachable, not an error response", async () => {
  const down = await probeManagedMcpEndpoint(ENDPOINT, { fetch: stubFetch(() => new Response("bad gateway", { status: 503 })) });
  assert.equal(down.outcome, "unreachable");
  assert.equal(down.error?.code, "managed_mcp_unreachable");
  const offline = await probeManagedMcpEndpoint(ENDPOINT, { fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
  assert.equal(offline.outcome, "unreachable");
});

test("probe reports a blocked OAuth metadata address as a policy refusal, not a header requirement", async () => {
  const fake = (async (input: URL | RequestInfo) => {
    const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
    if (url === ENDPOINT) return new Response("unauthorized", { status: 401 });
    throw new ManagedMcpGatewayError("network security check blocked the address", "managed_mcp_endpoint_blocked");
  }) as typeof fetch;
  const result = await probeManagedMcpEndpoint(ENDPOINT, { fetch: fake });
  assert.equal(result.outcome, "unreachable");
  assert.equal(result.error?.code, "managed_mcp_endpoint_blocked");
});

test("⭐ probe: private, local and non-HTTPS endpoints are refused before any request", async () => {
  for (const [url, code] of [
    ["https://127.0.0.1/mcp", "managed_mcp_endpoint_blocked"],
    ["https://169.254.169.254/latest/meta-data", "managed_mcp_endpoint_blocked"],
    ["https://localhost/mcp", "managed_mcp_endpoint_blocked"],
    ["http://probe.example.test/mcp", "managed_mcp_endpoint_invalid"],
    ["https://probe.example.test/mcp?token=fixture", "managed_mcp_endpoint_invalid"],
  ] as const) {
    let requests = 0;
    await assert.rejects(
      probeManagedMcpEndpoint(url, { fetch: (async () => { requests += 1; return new Response(null, { status: 500 }); }) as typeof fetch }),
      (error: unknown) => error instanceof ManagedMcpGatewayError && error.code === code,
      url,
    );
    assert.equal(requests, 0, url);
  }
});

test("⭐ probe: ONE deadline covers the handshake and the metadata discovery after a 401", async () => {
  const unsignalled: string[] = [];
  // The endpoint answers 401 at once; every discovery document stalls. A request tied to the probe's
  // deadline is aborted with it; one that is not would sit for its own 3 s, sequentially.
  const stalling = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
    if (url === ENDPOINT) return new Response("unauthorized", { status: 401 });
    const signal = init?.signal;
    if (!signal) unsignalled.push(url);
    return new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      const timer = setTimeout(() => resolve(new Response("not found", { status: 404 })), 3_000);
      signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("aborted", "AbortError")); }, { once: true });
    });
  }) as typeof fetch;
  const startedAt = Date.now();
  const result = await probeManagedMcpEndpointWithCatalog(ENDPOINT, { fetch: stalling, timeoutMs: 300 });
  const elapsed = Date.now() - startedAt;
  assert.deepEqual(unsignalled, [], "every discovery request carries the probe's deadline");
  assert.ok(elapsed < 2_500, `⭐ the probe ends at its deadline, not after each request's own timeout (took ${elapsed} ms)`);
  assert.equal(result.result.outcome, "unreachable", "metadata that never arrived is not guessed as \"headers\"");
  assert.equal(result.result.error?.message, "MCP server did not answer in time");
});
