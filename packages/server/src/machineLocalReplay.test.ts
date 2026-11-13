import assert from "node:assert/strict";
import { BasicTracer, MemoryTraceSink, parseTraceparent } from "@botiverse/raft-shared";
import type { Request, Response } from "express";

import {
  buildReplayHeaders,
  buildReplayTargetUrl,
  handleMachineLocalProbeRouting,
  handleMachineLocalRouting,
  isMachineLocalReplayAllowed,
  sendMachineAffinityUnavailable,
  type MachineLocalRoutingDeps,
} from "./machineLocalReplay";
import { normalizeReplicaReplayEndpoint } from "./replicaRouter";
import { runWithTraceSpan } from "./tracing/semanticTrace";

test("machine-local replay allowlist is limited to daemon-affinity routes", () => {
  assert.equal(isMachineLocalReplayAllowed("GET", "/api/agents/agent-1/skills"), true);
  assert.equal(isMachineLocalReplayAllowed("POST", "/api/agents"), true);
  assert.equal(
    isMachineLocalReplayAllowed("PATCH", "/api/agents/agent-1"),
    true,
  );
  assert.equal(isMachineLocalReplayAllowed("POST", "/api/agents/agent-1/start"), true);
  // Retired: /migrate is the only way an agent changes Computer.
  assert.equal(
    isMachineLocalReplayAllowed("POST", "/api/agents/agent-1/assign-machine"),
    false,
  );
  assert.equal(
    isMachineLocalReplayAllowed("POST", "/api/agents/agent-1/migrate"),
    true,
  );
  assert.equal(isMachineLocalReplayAllowed("GET", "/api/agents/agent-1/workspace-files?dirPath=notes"), true);
  assert.equal(isMachineLocalReplayAllowed("GET", "/api/servers/server-1/machines/machine-1/runtime-models/claude"), true);
  assert.equal(
    isMachineLocalReplayAllowed(
      "GET",
      "/api/servers/server-1/machines/machine-1/runtime-form-definitions/builtin/option-sources/model?schemaVersion=builtin-pi.create.v3",
    ),
    true,
  );
  assert.equal(
    isMachineLocalReplayAllowed("GET", "/api/servers/server-1/machines/machine-1/runtime-forms/v2/builtin/option-sources/model"),
    true,
  );
  // task #10: the Built-in v2 definition reads the Computer's model source too.
  assert.equal(isMachineLocalReplayAllowed("GET", "/api/servers/server-1/machines/machine-1/runtime-forms/v2/builtin"), true);
  assert.equal(isMachineLocalReplayAllowed("POST", "/api/servers/server-1/machines/machine-1/runtime-forms/v2/builtin"), false);
  assert.equal(isMachineLocalReplayAllowed("GET", "/api/agents/agent-1/runtime-form"), true);
  assert.equal(isMachineLocalReplayAllowed("POST", "/api/servers/server-1/machines/machine-1/computer/restart"), true);
  assert.equal(isMachineLocalReplayAllowed(
    "POST",
    "/api/servers/server-1/machines/machine-1/computer-lifecycle-operations",
  ), true);

  assert.equal(isMachineLocalReplayAllowed("GET", "/api/messages/sync"), false);
  assert.equal(isMachineLocalReplayAllowed("POST", "/api/agents/agent-1/skills"), false);
  assert.equal(isMachineLocalReplayAllowed("GET", "/api/servers/server-1/members"), false);
  assert.equal(isMachineLocalReplayAllowed("GET", "/internal/agent-api/send"), false);
});

test("replica replay endpoints are normalized to origins and reject non-http schemes", () => {
  assert.equal(normalizeReplicaReplayEndpoint("http://10.50.1.23:3001/path?x=1"), "http://10.50.1.23:3001");
  assert.equal(normalizeReplicaReplayEndpoint("https://server.internal"), "https://server.internal");
  assert.equal(normalizeReplicaReplayEndpoint("ftp://10.50.1.23:3001"), null);
  assert.equal(normalizeReplicaReplayEndpoint("not a url"), null);
  assert.equal(normalizeReplicaReplayEndpoint(null), null);
});

test("replica replay injects the active ingress context as the owner span parent without changing sampling volume", () => {
  const ingressSink = new MemoryTraceSink();
  const ingressTracer = new BasicTracer({
    sink: ingressSink,
    traceIdGenerator: () => "a".repeat(32),
    spanIdGenerator: () => "b".repeat(16),
  });
  const inboundTraceparent = `00-${"1".repeat(32)}-${"2".repeat(16)}-01`;
  const ingressSpan = ingressTracer.startSpan("server.http.request", {
    parent: parseTraceparent(inboundTraceparent),
    surface: "server",
    kind: "server",
  });
  const req = {
    method: "GET",
    originalUrl: "/api/servers/server-1/machines/machine-1/runtime-models/claude",
    url: "/api/servers/server-1/machines/machine-1/runtime-models/claude",
    headers: {
      authorization: "Bearer test",
      traceparent: inboundTraceparent,
    },
  } as unknown as Request;

  const headers = runWithTraceSpan(
    ingressSpan,
    () => buildReplayHeaders(req, "machine-1", undefined),
    ingressTracer,
  );
  assert.equal(
    headers.get("traceparent"),
    `00-${"1".repeat(32)}-${"b".repeat(16)}-01`,
  );
  assert.equal(headers.get("authorization"), "Bearer test");

  const ownerParent = parseTraceparent(headers.get("traceparent"));
  assert.ok(ownerParent);
  const ownerSink = new MemoryTraceSink();
  const ownerTracer = new BasicTracer({
    sink: ownerSink,
    traceIdGenerator: () => "c".repeat(32),
    spanIdGenerator: () => "d".repeat(16),
  });
  const ownerSpan = ownerTracer.startSpan("server.http.request", {
    parent: ownerParent,
    surface: "server",
    kind: "server",
  });
  assert.equal(ownerSpan.context.traceId, ingressSpan.context.traceId);
  assert.equal(ownerSpan.context.parentSpanId, ingressSpan.context.spanId);
  assert.equal(ownerSpan.context.traceFlags, "01");

  ownerSpan.end("error");
  ingressSpan.end("error");
  assert.equal(ownerSink.getAllSpans().length, 1);
  assert.equal(ingressSink.getAllSpans().length, 1);
});

test("replica replay preserves an inbound traceparent when no active server span exists", () => {
  const originalTraceparent = `00-${"1".repeat(32)}-${"2".repeat(16)}-01`;
  const req = {
    method: "GET",
    originalUrl: "/api/agents/agent-1/skills",
    url: "/api/agents/agent-1/skills",
    headers: { traceparent: originalTraceparent },
  } as unknown as Request;

  const headers = buildReplayHeaders(req, "machine-1", undefined);
  assert.equal(headers.get("traceparent"), originalTraceparent);
});

function makeRoutingRequest(method = "GET"): Request {
  const url = method === "GET" ? "/api/agents/agent-1/skills" : "/api/agents/agent-1/start";
  return {
    method,
    originalUrl: url,
    url,
    headers: {},
    body: method === "GET" ? undefined : { action: "start" },
  } as unknown as Request;
}

function makeRoutingResponse(): Response & {
  statusCode: number;
  jsonBody?: unknown;
  sentBody?: unknown;
  ended: boolean;
} {
  const headers = new Map<string, string>();
  const response: {
    statusCode: number;
    jsonBody?: unknown;
    sentBody?: unknown;
    ended: boolean;
    status(code: number): typeof response;
    json(body: unknown): typeof response;
    send(body: unknown): typeof response;
    end(): typeof response;
    set(field: string, value: string): typeof response;
    setHeader(field: string, value: string): typeof response;
  } = {
    statusCode: 200,
    ended: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.jsonBody = body;
      return this;
    },
    send(body: unknown) {
      this.sentBody = body;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
    set(field: string, value: string) {
      headers.set(field.toLowerCase(), value);
      return this;
    },
    setHeader(field: string, value: string) {
      headers.set(field.toLowerCase(), value);
      return this;
    },
  };
  return response as unknown as Response & typeof response;
}

function routingDeps(overrides: Partial<MachineLocalRoutingDeps>): MachineLocalRoutingDeps {
  return {
    getReplayTarget: async () => null,
    clearOwner: async () => "missing",
    getFlyInstance: async () => null,
    fetch: async () => new globalThis.Response(null, { status: 204 }),
    sleep: async () => {},
    nowMs: () => 1_000_000,
    ...overrides,
  };
}

test("initial owner_missing waits through the bounded handoff window and rereads", async () => {
  const reads = [
    null,
    { replicaId: "replica-b", endpoint: "http://replica-b", generation: "generation-b", version: "version-b", currentReplica: false },
  ];
  const sleeps: number[] = [];
  const response = makeRoutingResponse();

  const handled = await handleMachineLocalRouting(
    makeRoutingRequest(),
    response,
    "machine-1",
    false,
    routingDeps({
      getReplayTarget: async () => reads.shift() ?? null,
      sleep: async (ms) => { sleeps.push(ms); },
      fetch: async () => new globalThis.Response("ok", { status: 200 }),
    }),
  );

  assert.equal(handled, "handled");
  assert.deepEqual(sleeps, [2_000]);
  assert.equal(reads.length, 0);
  assert.equal(response.statusCode, 200);
  assert.equal(Buffer.from(response.sentBody as Uint8Array).toString("utf8"), "ok");
});

test("handoff reread confirms local only after the live socket predicate changes", async () => {
  let local = false;
  const reads = [
    null,
    { replicaId: "replica-a", endpoint: null, generation: "generation-a", version: "version-a", currentReplica: true },
  ];

  const result = await handleMachineLocalRouting(
    makeRoutingRequest(),
    makeRoutingResponse(),
    "machine-1",
    () => local,
    routingDeps({
      getReplayTarget: async () => reads.shift() ?? null,
      sleep: async () => { local = true; },
    }),
  );

  assert.equal(result, "confirmed_local");
  assert.equal(reads.length, 0);
});

test("a current-replica owner snapshot without a live socket fails closed", async () => {
  const reads = [
    {
      replicaId: "replica-a",
      endpoint: "http://replica-a",
      generation: "generation-a",
      version: "version-a",
      currentReplica: true,
    },
    null,
  ];
  const cleared: Array<{
    machineId: string;
    replicaId: string;
    generation: string;
    version: string;
    endpoint?: string;
  }> = [];
  const result = await handleMachineLocalRouting(
    makeRoutingRequest(),
    makeRoutingResponse(),
    "machine-1",
    () => false,
    routingDeps({
      getReplayTarget: async () => reads.shift() ?? null,
      clearOwner: async (machineId, replicaId, generation, version, endpoint) => {
        cleared.push({ machineId, replicaId, generation, version, endpoint });
        return "deleted";
      },
    }),
  );

  // The cleared stale snapshot was the only owner and the reread finds none:
  // no replica holds the socket, so the machine is offline.
  assert.equal(result, "owner_missing");
  assert.deepEqual(cleared, [{
    machineId: "machine-1",
    replicaId: "replica-a",
    generation: "generation-a",
    version: "version-a",
    endpoint: "http://replica-a",
  }]);
  assert.equal(reads.length, 0, "GET may spend its one successor reread after exact cleanup");
});

test("a stale current-replica GET rereads and routes to one successor", async () => {
  const targets = [
    {
      replicaId: "replica-a",
      endpoint: "http://replica-a",
      generation: "generation-a",
      version: "version-a",
      currentReplica: true,
    },
    {
      replicaId: "replica-b",
      endpoint: "http://replica-b",
      generation: "generation-b",
      version: "version-b",
      currentReplica: false,
    },
  ];
  const cleared: string[] = [];
  const fetched: string[] = [];
  const response = makeRoutingResponse();

  const result = await handleMachineLocalRouting(
    makeRoutingRequest("GET"),
    response,
    "machine-1",
    false,
    routingDeps({
      getReplayTarget: async () => targets.shift() ?? null,
      clearOwner: async (_machineId, replicaId) => {
        cleared.push(replicaId);
        return "deleted";
      },
      fetch: async (input) => {
        fetched.push(String(input));
        return new globalThis.Response("successor", { status: 200 });
      },
    }),
  );

  assert.equal(result, "handled");
  assert.deepEqual(cleared, ["replica-a"]);
  assert.deepEqual(fetched, ["http://replica-b/api/agents/agent-1/skills"]);
  assert.equal(Buffer.from(response.sentBody as Uint8Array).toString("utf8"), "successor");
});

test("a successor found after stale-current cleanup cannot open a second discovery budget", async () => {
  const targets = [
    {
      replicaId: "replica-a",
      endpoint: "http://replica-a",
      generation: "generation-a",
      version: "version-a",
      currentReplica: true,
    },
    {
      replicaId: "replica-b",
      endpoint: "http://replica-b",
      generation: "generation-b",
      version: "version-b",
      currentReplica: false,
    },
    {
      replicaId: "replica-c",
      endpoint: "http://replica-c",
      generation: "generation-c",
      version: "version-c",
      currentReplica: false,
    },
  ];
  const cleared: string[] = [];
  const fetched: string[] = [];
  let reads = 0;
  const response = makeRoutingResponse();

  const result = await handleMachineLocalRouting(
    makeRoutingRequest("GET"),
    response,
    "machine-1",
    false,
    routingDeps({
      getReplayTarget: async () => {
        reads += 1;
        return targets.shift() ?? null;
      },
      clearOwner: async (_machineId, replicaId) => {
        cleared.push(replicaId);
        return "deleted";
      },
      fetch: async (input) => {
        fetched.push(String(input));
        return new globalThis.Response(JSON.stringify({ code: "machine_owner_not_local" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      },
    }),
  );

  assert.equal(result, "handled");
  assert.equal(reads, 2, "the stale-current cleanup already spent the only successor discovery");
  assert.deepEqual(fetched, ["http://replica-b/api/agents/agent-1/skills"]);
  assert.deepEqual(cleared, ["replica-a", "replica-b"]);
  assert.equal(targets.length, 1, "replica-c must remain undiscovered");
  assert.equal(response.statusCode, 409);
  assert.deepEqual(JSON.parse(Buffer.from(response.sentBody as Uint8Array).toString("utf8")), {
    code: "machine_owner_not_local",
  });
});

test("a stale current-replica POST exact-cleans and never rereads or replays", async () => {
  let reads = 0;
  let fetches = 0;
  const cleared: string[] = [];

  const result = await handleMachineLocalRouting(
    makeRoutingRequest("POST"),
    makeRoutingResponse(),
    "machine-1",
    false,
    routingDeps({
      getReplayTarget: async () => {
        reads += 1;
        return {
          replicaId: "replica-a",
          endpoint: "http://replica-a",
          generation: "generation-a",
          version: "version-a",
          currentReplica: true,
        };
      },
      clearOwner: async (_machineId, replicaId) => {
        cleared.push(replicaId);
        return "deleted";
      },
      fetch: async () => {
        fetches += 1;
        return new globalThis.Response(null, { status: 204 });
      },
    }),
  );

  assert.equal(result, "not_routed");
  assert.equal(reads, 1);
  assert.equal(fetches, 0);
  assert.deepEqual(cleared, ["replica-a"]);
});

test("handoff reread exact-cleans a current-replica owner without a live socket", async () => {
  const reads = [
    null,
    {
      replicaId: "replica-a",
      endpoint: "http://replica-a",
      generation: "generation-a",
      version: "version-a",
      currentReplica: true,
    },
  ];
  const cleared: string[] = [];
  const sleeps: number[] = [];

  const result = await handleMachineLocalRouting(
    makeRoutingRequest("GET"),
    makeRoutingResponse(),
    "machine-1",
    false,
    routingDeps({
      getReplayTarget: async () => reads.shift() ?? null,
      clearOwner: async (_machineId, replicaId) => {
        cleared.push(replicaId);
        return "deleted";
      },
      sleep: async (ms) => { sleeps.push(ms); },
    }),
  );

  assert.equal(result, "not_routed");
  assert.deepEqual(sleeps, [2_000]);
  assert.deepEqual(cleared, ["replica-a"]);
  assert.equal(reads.length, 0);
});

test("typed owner_not_local CAS-clears the exact owner and reroutes one GET", async () => {
  const targets = [
    { replicaId: "replica-a", endpoint: "http://replica-a", generation: "generation-a", version: "version-a", currentReplica: false },
    { replicaId: "replica-b", endpoint: "http://replica-b", generation: "generation-b", version: "version-b", currentReplica: false },
  ];
  const cleared: Array<{
    machineId: string;
    replicaId: string;
    generation: string;
    version: string;
    endpoint?: string;
  }> = [];
  const fetched: string[] = [];
  const response = makeRoutingResponse();

  const handled = await handleMachineLocalRouting(
    makeRoutingRequest("GET"),
    response,
    "machine-1",
    false,
    routingDeps({
      getReplayTarget: async () => targets.shift() ?? null,
      clearOwner: async (machineId, replicaId, generation, version, endpoint) => {
        cleared.push({ machineId, replicaId, generation, version, endpoint });
        return "deleted";
      },
      fetch: async (input) => {
        fetched.push(String(input));
        if (fetched.length === 1) {
          return new globalThis.Response(JSON.stringify({ code: "machine_owner_not_local" }), {
            status: 409,
            headers: { "content-type": "application/json" },
          });
        }
        return new globalThis.Response("successor", { status: 200 });
      },
    }),
  );

  assert.equal(handled, "handled");
  assert.deepEqual(cleared, [{
    machineId: "machine-1",
    replicaId: "replica-a",
    generation: "generation-a",
    version: "version-a",
    endpoint: "http://replica-a",
  }]);
  assert.deepEqual(fetched, [
    "http://replica-a/api/agents/agent-1/skills",
    "http://replica-b/api/agents/agent-1/skills",
  ]);
  assert.equal(response.statusCode, 200);
  assert.equal(Buffer.from(response.sentBody as Uint8Array).toString("utf8"), "successor");
});

test("stale cleanup cannot delete a re-registered generation on the same replica", async () => {
  let target = {
    replicaId: "replica-a",
    endpoint: "http://replica-a-old",
    generation: "generation-a",
    version: "version-a",
    currentReplica: false,
  };
  const clearAttempts: Array<{
    replicaId: string;
    generation: string;
    version: string;
    endpoint?: string;
  }> = [];
  const fetched: string[] = [];
  const response = makeRoutingResponse();

  const handled = await handleMachineLocalRouting(
    makeRoutingRequest("GET"),
    response,
    "machine-1",
    false,
    routingDeps({
      getReplayTarget: async () => target,
      clearOwner: async (_machineId, replicaId, generation, version, endpoint) => {
        clearAttempts.push({ replicaId, generation, version, endpoint });
        target = {
          replicaId: "replica-a",
          endpoint: "http://replica-a-new",
          generation: "generation-b",
          version: "version-b",
          currentReplica: false,
        };
        return "mismatch";
      },
      fetch: async (input) => {
        fetched.push(String(input));
        if (fetched.length === 1) {
          return new globalThis.Response(JSON.stringify({ code: "machine_owner_not_local" }), {
            status: 409,
            headers: { "content-type": "application/json" },
          });
        }
        return new globalThis.Response("refreshed-successor", { status: 200 });
      },
    }),
  );

  assert.equal(handled, "handled");
  assert.deepEqual(clearAttempts, [{
    replicaId: "replica-a",
    generation: "generation-a",
    version: "version-a",
    endpoint: "http://replica-a-old",
  }]);
  assert.deepEqual(fetched, [
    "http://replica-a-old/api/agents/agent-1/skills",
    "http://replica-a-new/api/agents/agent-1/skills",
  ]);
  assert.equal(Buffer.from(response.sentBody as Uint8Array).toString("utf8"), "refreshed-successor");
});

test("a rerouted GET clears a second exact owner_not_local without a third replay", async () => {
  const cleared: Array<{ machineId: string; replicaId: string; generation: string; version: string }> = [];
  const targets = [
    { replicaId: "replica-a", endpoint: "http://replica-a", generation: "generation-a", version: "version-a", currentReplica: false },
    { replicaId: "replica-b", endpoint: "http://replica-b", generation: "generation-b", version: "version-b", currentReplica: false },
  ];
  let fetchCount = 0;
  const response = makeRoutingResponse();

  const handled = await handleMachineLocalRouting(
    makeRoutingRequest("GET"),
    response,
    "machine-1",
    false,
    routingDeps({
      getReplayTarget: async () => targets.shift() ?? {
        replicaId: "replica-c",
        endpoint: "http://replica-c",
        generation: "generation-c",
        version: "version-c",
        currentReplica: false,
      },
      clearOwner: async (machineId, replicaId, generation, version) => {
        cleared.push({ machineId, replicaId, generation, version });
        return "deleted";
      },
      fetch: async () => {
        fetchCount += 1;
        return new globalThis.Response(JSON.stringify({ code: "machine_owner_not_local" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      },
    }),
  );

  assert.equal(handled, "handled");
  assert.equal(fetchCount, 2, "the reroute budget is exactly one successor attempt");
  assert.deepEqual(cleared, [
    { machineId: "machine-1", replicaId: "replica-a", generation: "generation-a", version: "version-a" },
    { machineId: "machine-1", replicaId: "replica-b", generation: "generation-b", version: "version-b" },
  ]);
  assert.equal(response.statusCode, 409);
  assert.deepEqual(JSON.parse(Buffer.from(response.sentBody as Uint8Array).toString("utf8")), {
    code: "machine_owner_not_local",
  });
});

for (const [label, ownerUpdatedAtMs, expectedClears] of [
  ["a lease refreshed under a minute ago is kept", 1_000_000 - 59_999, 0],
  ["a lease unrefreshed for a minute is cleared", 1_000_000 - 60_000, 1],
] as const) {
  test(`task #440: replay timeout proves nothing about a live owner; ${label}, and POST is never replayed`, async () => {
    const cleared: Array<{ machineId: string; replicaId: string; generation: string; version: string }> = [];
    let fetchCount = 0;
    let rereadCount = 0;
    const response = makeRoutingResponse();
    const abort = new Error("timeout");
    abort.name = "AbortError";
    const version = String(ownerUpdatedAtMs);

    const handled = await handleMachineLocalRouting(
      makeRoutingRequest("POST"),
      response,
      "machine-1",
      false,
      routingDeps({
        getReplayTarget: async () => {
          rereadCount += 1;
          return {
            replicaId: "replica-a",
            endpoint: "http://replica-a",
            generation: "generation-a",
            version,
            currentReplica: false,
          };
        },
        clearOwner: async (machineId, replicaId, generation, clearedVersion) => {
          cleared.push({ machineId, replicaId, generation, version: clearedVersion });
          return "deleted";
        },
        fetch: async () => {
          fetchCount += 1;
          throw abort;
        },
      }),
    );

    assert.equal(handled, "handled");
    assert.equal(fetchCount, 1);
    assert.equal(rereadCount, 1, "non-idempotent failure must not discover a blind replay target");
    assert.deepEqual(cleared, expectedClears === 0 ? [] : [{
      machineId: "machine-1",
      replicaId: "replica-a",
      generation: "generation-a",
      version,
    }]);
    assert.equal(response.statusCode, 504);
    assert.deepEqual(response.jsonBody, {
      error: "Timed out routing request to machine owner replica",
      code: "machine_affinity_replay_timeout",
      machineAffinityRoute: "timeout",
    });
  });
}

test("a probe GET whose replay fails returns the failure to the route instead of a 504/503; other routes keep them", async () => {
  const abort = new Error("timeout");
  abort.name = "AbortError";
  const ownerGone = () => routingDeps({
    // Fresh lease: the failed replay never clears the owner, so there is no reroute.
    getReplayTarget: async () => ({
      replicaId: "replica-a",
      endpoint: "http://replica-a",
      generation: "generation-a",
      version: String(1_000_000),
      currentReplica: false,
    }),
  });
  const probeRequest = () => ({
    method: "GET",
    originalUrl: "/api/servers/server-1/machines/machine-1/runtime-models/codex",
    url: "/api/servers/server-1/machines/machine-1/runtime-models/codex",
    headers: {},
  } as unknown as Request);

  for (const [failure, expected] of [
    [abort, "replay_timeout"],
    [new Error("ECONNREFUSED"), "replay_failed"],
  ] as const) {
    const response = makeRoutingResponse();
    const routed = await handleMachineLocalProbeRouting(probeRequest(), response, "machine-1", false, {
      ...ownerGone(),
      fetch: async () => { throw failure; },
    });
    assert.equal(routed, expected);
    assert.equal(response.jsonBody, undefined, "nothing was sent: the route answers");
    assert.equal(response.sentBody, undefined);
  }

  // The owner replica answering is still forwarded as is.
  const answered = makeRoutingResponse();
  assert.equal(await handleMachineLocalProbeRouting(probeRequest(), answered, "machine-1", false, {
    ...ownerGone(),
    fetch: async () => new globalThis.Response(JSON.stringify({ kind: "live" }), { status: 200 }),
  }), "handled");
  assert.equal(answered.statusCode, 200);

  // A route that did not opt in keeps the 504.
  const plain = makeRoutingResponse();
  assert.equal(await handleMachineLocalRouting(makeRoutingRequest("GET"), plain, "machine-1", false, {
    ...ownerGone(),
    fetch: async () => { throw abort; },
  }), "handled");
  assert.equal(plain.statusCode, 504);
  assert.equal((plain.jsonBody as { code?: string }).code, "machine_affinity_replay_timeout");
});

test("a probe GET whose owner answers machine_owner_not_local with no replacement is owner_missing (offline), not a replay failure", async () => {
  const cleared: string[] = [];
  let reads = 0;
  const response = makeRoutingResponse();
  const routed = await handleMachineLocalProbeRouting({
    method: "GET",
    originalUrl: "/api/servers/server-1/machines/machine-1/runtime-models/codex",
    url: "/api/servers/server-1/machines/machine-1/runtime-models/codex",
    headers: {},
  } as unknown as Request, response, "machine-1", false, routingDeps({
    getReplayTarget: async () => {
      reads += 1;
      return reads === 1
        ? { replicaId: "replica-a", endpoint: "http://replica-a", generation: "generation-a", version: "version-a", currentReplica: false }
        : null;
    },
    clearOwner: async (_machineId, replicaId) => {
      cleared.push(replicaId);
      return "deleted";
    },
    fetch: async () => new globalThis.Response(JSON.stringify({ code: "machine_owner_not_local" }), { status: 409 }),
  }));
  assert.equal(routed, "owner_missing");
  assert.deepEqual(cleared, ["replica-a"], "the typed answer still clears the stale owner");
  assert.equal(response.sentBody, undefined, "the route answers offline itself");
  assert.equal(response.jsonBody, undefined);
});

test("task #440: a transport failure keeps an owner whose lease is not a parseable timestamp", async () => {
  let clears = 0;
  const response = makeRoutingResponse();
  await handleMachineLocalRouting(
    makeRoutingRequest("POST"),
    response,
    "machine-1",
    false,
    routingDeps({
      getReplayTarget: async () => ({
        replicaId: "replica-a",
        endpoint: "http://replica-a",
        generation: "generation-a",
        version: "version-a",
        currentReplica: false,
      }),
      clearOwner: async () => {
        clears += 1;
        return "deleted";
      },
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    }),
  );
  assert.equal(clears, 0);
  assert.equal(response.statusCode, 503);
});

test("business 409 is forwarded without clearing machine ownership", async () => {
  let clearCount = 0;
  const response = makeRoutingResponse();

  await handleMachineLocalRouting(
    makeRoutingRequest("GET"),
    response,
    "machine-1",
    false,
    routingDeps({
      getReplayTarget: async () => ({
        replicaId: "replica-a",
        endpoint: "http://replica-a",
        generation: "generation-a",
        version: "version-a",
        currentReplica: false,
      }),
      clearOwner: async () => {
        clearCount += 1;
        return "deleted";
      },
      fetch: async () => new globalThis.Response(JSON.stringify({ code: "business_conflict" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    }),
  );

  assert.equal(clearCount, 0);
  assert.equal(response.statusCode, 409);
});

test("replay target keeps the owner replica's host whatever the incoming request line says", () => {
  const endpoint = "http://10.0.1.5:3001";
  assert.equal(buildReplayTargetUrl("/api/agents/agent-1/skills?x=1", endpoint).href, "http://10.0.1.5:3001/api/agents/agent-1/skills?x=1");
  // absolute-form request line
  assert.equal(buildReplayTargetUrl("http://169.254.169.254/api/agents/agent-1/skills", endpoint).host, "10.0.1.5:3001");
  // protocol-relative path
  const protocolRelative = buildReplayTargetUrl("//internal.example/api/agents/agent-1/skills", endpoint);
  assert.equal(protocolRelative.host, "10.0.1.5:3001");
  assert.equal(protocolRelative.pathname, "/api/agents/agent-1/skills");
});

test("only owner_missing answers 409 machine_offline; a write while another replica owns the machine keeps 503", async () => {
  const offline = await handleMachineLocalRouting(
    makeRoutingRequest("GET"),
    makeRoutingResponse(),
    "machine-1",
    () => false,
    routingDeps({ getReplayTarget: async () => null }),
  );
  assert.equal(offline, "owner_missing");
  const offlineResponse = makeRoutingResponse();
  sendMachineAffinityUnavailable(offlineResponse, "machine-1", offline);
  assert.equal(offlineResponse.statusCode, 409);
  assert.equal((offlineResponse.jsonBody as { code: string }).code, "machine_offline");

  // POST start on a machine another replica owns: the request stays here, but
  // the machine is online, so the answer must stay the retryable 503.
  const write = await handleMachineLocalRouting(
    makeRoutingRequest("POST"),
    makeRoutingResponse(),
    "machine-1",
    () => false,
    routingDeps({
      getReplayTarget: async () => ({
        replicaId: "replica-b",
        endpoint: "http://replica-b",
        generation: "generation-b",
        version: "version-b",
        currentReplica: false,
      }),
    }),
  );
  assert.notEqual(write, "owner_missing");
  if (write !== "handled") {
    const writeResponse = makeRoutingResponse();
    sendMachineAffinityUnavailable(writeResponse, "machine-1", write);
    assert.equal(writeResponse.statusCode, 503);
    assert.equal((writeResponse.jsonBody as { code: string }).code, "machine_affinity_unavailable");
  }
});
