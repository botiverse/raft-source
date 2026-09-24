import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import { BasicTracer, MemoryTraceSink, parseTraceparent } from "@botiverse/raft-shared";
import type { Request, Response } from "express";

import {
  buildReplayHeaders,
  handleMachineLocalRouting,
  isMachineLocalReplayAllowed,
  type MachineLocalRoutingDeps,
} from "./machineLocalReplay.js";
import { normalizeReplicaReplayEndpoint } from "./replicaRouter.js";
import { runWithTraceSpan } from "./tracing/semanticTrace.js";

test("machine-local replay allowlist is limited to daemon-affinity routes", () => {
  assert.equal(isMachineLocalReplayAllowed("GET", "/api/agents/agent-1/skills"), true);
  assert.equal(isMachineLocalReplayAllowed("POST", "/api/agents"), true);
  assert.equal(
    isMachineLocalReplayAllowed("PATCH", "/api/agents/agent-1"),
    true,
  );
  assert.equal(isMachineLocalReplayAllowed("POST", "/api/agents/agent-1/start"), true);
  assert.equal(
    isMachineLocalReplayAllowed("POST", "/api/agents/agent-1/assign-machine"),
    true,
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
      "/api/servers/server-1/machines/machine-1/runtime-form-definitions/builtin/option-sources/model?schemaVersion=builtin-pi.create.v2",
    ),
    true,
  );
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

  assert.equal(result, "not_routed");
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

test("Redis owner cleanup compares the observed generation before deletion", async () => {
  const source = await readFile(new URL("./replicaRouter.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /if currentGeneration ~= ARGV\[2\] then\s+return 0\s+end/,
    "the Redis CAS must reject a same-replica successor generation",
  );
  assert.match(
    source,
    /if currentUpdatedAt ~= ARGV\[3\] then\s+return 0\s+end/,
    "the Redis CAS must reject a refreshed snapshot version",
  );
  assert.match(
    source,
    /ARGV\[4\] ~= "" and redis\.call\("GET", KEYS\[8\]\) ~= ARGV\[4\]/,
    "the Redis CAS must reject a changed replay endpoint",
  );
  assert.match(
    source,
    /redis\.call\("SET", KEYS\[2\], ARGV\[2\], "EX", ARGV\[8\]\)/,
    "heartbeat refresh must preserve the registered lease generation",
  );
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

test("ambiguous replay timeout clears the observed owner but never replays POST", async () => {
  const cleared: Array<{ machineId: string; replicaId: string; generation: string; version: string }> = [];
  let fetchCount = 0;
  let rereadCount = 0;
  const response = makeRoutingResponse();
  const abort = new Error("timeout");
  abort.name = "AbortError";

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
          version: "version-a",
          currentReplica: false,
        };
      },
      clearOwner: async (machineId, replicaId, generation, version) => {
        cleared.push({ machineId, replicaId, generation, version });
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
  assert.deepEqual(cleared, [{
    machineId: "machine-1",
    replicaId: "replica-a",
    generation: "generation-a",
    version: "version-a",
  }]);
  assert.equal(response.statusCode, 504);
  assert.deepEqual(response.jsonBody, {
    error: "Timed out routing request to machine owner replica",
    code: "machine_affinity_replay_timeout",
    machineAffinityRoute: "timeout",
  });
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
