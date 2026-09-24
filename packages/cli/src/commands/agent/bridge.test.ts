import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Command } from "commander";

import type { ApiResponse } from "../../client.js";
import type { AgentContext } from "../../auth/env.js";
import { createCommandContext } from "../../core/context.js";
import type { CliIo } from "../../core/io.js";
import { getConsumedSeq } from "../message/_consumedSeqState.js";
import { agentBridgeCommand, registerAgentBridgeCommand } from "./bridge.js";

function memoryIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
      stderr: { write: (chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; } },
    },
  };
}

const agentContext: AgentContext = {
  agentId: "agent-1",
  serverUrl: "https://slock.example",
  serverId: "server-1",
  token: "sk_agent_test",
  clientMode: "self-hosted-runner",
  secretSource: "profile-credential-file",
  activeCapabilities: null,
  profileSlug: "profile-1",
  profileCredentialPath: "/tmp/profile.json",
};

function runAgentBridge(
  ctx: Parameters<typeof agentBridgeCommand.handler>[0],
  options: Parameters<typeof agentBridgeCommand.handler>[1],
) {
  return agentBridgeCommand.handler(ctx, { expectedAgent: agentContext.agentId, ...options });
}

test("agent bridge is an explicit agent subcommand with JSON protocol mode", () => {
  const program = new Command();
  program.option("-p, --profile <slug>", "Use existing profile");
  const agentCmd = program.command("agent");
  registerAgentBridgeCommand(agentCmd);

  const bridgeCmd = agentCmd.commands.find((command) => command.name() === "bridge");
  assert.ok(bridgeCmd, "bridge subcommand should be registered only under `raft agent`");
  assert.ok(bridgeCmd!.options.some((option) => option.long === "--json"));
  assert.ok(bridgeCmd!.options.some((option) => option.long === "--once"));
  assert.ok(bridgeCmd!.options.some((option) => option.long === "--expected-agent"));
  assert.equal(
    bridgeCmd!.options.find((option) => option.long === "--profile"),
    undefined,
    "bridge must use root --profile and must not shadow it with a subcommand flag.",
  );
});

test("agent bridge requires an independent expected identity before any request", async () => {
  const { io } = memoryIo();
  let requests = 0;
  const ctx = createCommandContext({
    io,
    env: {},
    loadAgentContext: () => agentContext,
    createApiClient: () => {
      requests += 1;
      throw new Error("must not construct client");
    },
  });

  await assert.rejects(
    async () => { await agentBridgeCommand.handler(ctx, { once: true }); },
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "BRIDGE_EXPECTED_AGENT_REQUIRED",
  );
  assert.equal(requests, 0);
});

test("agent bridge rejects a profile/expected-agent mismatch with zero requests", async () => {
  const { io } = memoryIo();
  let requests = 0;
  const ctx = createCommandContext({
    io,
    env: { RAFT_EXPECTED_AGENT_ID: "agent-other" },
    loadAgentContext: () => agentContext,
    createApiClient: () => {
      requests += 1;
      throw new Error("must not construct client");
    },
  });

  await assert.rejects(
    async () => { await agentBridgeCommand.handler(ctx, { once: true }); },
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "BRIDGE_IDENTITY_MISMATCH",
  );
  assert.equal(requests, 0);
});

test("agent bridge polls content-free wake hints, not draining events", async () => {
  const { io, stdout, stderr } = memoryIo();
  const requests: Array<{ method: string; path: string }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path });
        return {
          ok: true,
          status: 200,
          error: null,
          data: {
            wake_hints: [{
              event_id: "wake-hint:msg-1",
              seq: 201,
              target: "channelId:channel-1",
              wake_reason: "message_pending",
            }],
            last_hint_seq: 201,
            has_more: false,
          },
        };
      },
    }) as any,
  });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "slock-agent-bridge-command-"));

  await runAgentBridge(ctx, {
    once: true,
    json: true,
    stateDir,
  });

  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/wake-hints?since=latest&limit=50" },
  ]);
  assert.deepEqual(stderr, []);
  const output = stdout.join("");
  assert.match(output, /"wakeHintId":"wake-hint:msg-1"/);
  assert.match(output, /"deliveryAck":false/);
  assert.doesNotMatch(output, /internal\/agent-api\/events/);
});

test("agent bridge can emit Claude Code wake adapter failures without consuming message bodies", async () => {
  const { io, stdout, stderr } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: true,
        status: 200,
        error: null,
        data: {
          wake_hints: [{
            event_id: "wake-hint:msg-1",
            message_id: "msg-1",
            seq: 201,
            target: "channelId:channel-1",
            wake_reason: "message_pending",
            content: "must not leak",
          }],
          last_hint_seq: 201,
          has_more: false,
        },
      }),
    }) as any,
  });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "slock-agent-bridge-command-"));

  await runAgentBridge(ctx, {
    once: true,
    json: true,
    stateDir,
    wakeAdapter: "wake-channel",
  });

  assert.deepEqual(stderr, []);
  const output = stdout.join("");
  assert.match(output, /"kind":"wake_attempt"/);
  assert.match(output, /"failureClass":"no_session"/);
  assert.match(output, /"messageId":"msg-1"/);
  assert.doesNotMatch(output, /must not leak/);
});

test("agent bridge passes Claude channel token from env instead of argv", async () => {
  const { io, stdout } = memoryIo();
  let tokenHeader: string | undefined;
  const server = http.createServer((req, res) => {
    tokenHeader = req.headers["x-raft-bridge-token"] as string | undefined;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, runtimeSession: "claude-session-1" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const ctx = createCommandContext({
      io,
      env: { RAFT_CHANNEL_TOKEN: "env-token" },
      loadAgentContext: () => agentContext,
      createApiClient: () => ({
        request: async (): Promise<ApiResponse<unknown>> => ({
          ok: true,
          status: 200,
          error: null,
          data: {
            wake_hints: [{
              event_id: "wake-hint:msg-1",
              message_id: "msg-1",
              seq: 201,
              target: "channelId:channel-1",
              wake_reason: "message_pending",
            }],
            last_hint_seq: 201,
            has_more: false,
          },
        }),
      }) as any,
    });
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "slock-agent-bridge-command-"));

    await runAgentBridge(ctx, {
      once: true,
      json: true,
      stateDir,
      wakeAdapter: "wake-channel",
      wakeChannelEndpoint: `http://127.0.0.1:${address.port}/wake`,
    });

    assert.equal(tokenHeader, "env-token");
    const output = stdout.join("");
    assert.match(output, /"proofLevel":"wake_injected"/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

test("agent bridge consumes wake-hint stream as a non-cursor peek source", async () => {
  const { io, stdout } = memoryIo();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "slock-agent-bridge-stream-"));
  const consumedStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "slock-agent-bridge-consumed-"));
  const priorConsumedStateDir = process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR;
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = consumedStateDir;

  const streamRequests: string[] = [];
  const pollRequests: string[] = [];
  const sse = [
    "event: wake-hint",
    "id: 301",
    "data: {\"event_id\":\"wake-hint:stream-1\",\"message_id\":\"msg-stream-1\",\"seq\":301,\"target\":\"#external-agent\",\"wake_reason\":\"message_pending\"}",
    "",
    "",
  ].join("\n");
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      streamWakeHints: async (query: URLSearchParams) => {
        streamRequests.push(`GET /internal/agent-api/wake-hints/stream?${query.toString()}`);
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sse));
            controller.close();
          },
        });
        return {
          ok: true,
          status: 200,
          error: null,
          response: new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
        };
      },
      request: async (method: string, path: string): Promise<ApiResponse<unknown>> => {
        if (path.includes("/activity")) return { ok: true, status: 200, error: null, data: { ok: true, acceptedCount: 1, rejectedCount: 0, droppedCount: 0 } };
        pollRequests.push(`${method} ${path}`);
        return { ok: false, status: 401, error: "credential revoked", data: null };
      },
    }) as any,
  });

  try {
    await assert.rejects(
      async () => runAgentBridge(ctx, {
        json: true,
        stateDir,
        pollIntervalMs: "1",
      }),
      (err: unknown) => err instanceof CliError && err.code === "BRIDGE_WAKE_HINTS_FAILED",
    );
    assert.deepEqual(streamRequests, [
      "GET /internal/agent-api/wake-hints/stream?since=latest",
    ]);
    assert.deepEqual(pollRequests, [
      "GET /internal/agent-api/wake-hints?since=301&limit=50",
    ]);
    const output = stdout.join("");
    assert.match(output, /"wakeHintId":"wake-hint:stream-1"/);
    assert.match(output, /"deliveryAck":false/);
    assert.equal(
      getConsumedSeq(agentContext.agentId, "#external-agent"),
      undefined,
      "stream wake hints are content-free peek triggers and must not advance FH-EXT consumed cursors",
    );
  } finally {
    if (priorConsumedStateDir === undefined) {
      delete process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR;
    } else {
      process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = priorConsumedStateDir;
    }
  }
});

test("agent bridge drains buffered wake-hint stream bursts before reading the next chunk", async () => {
  const { io, stdout } = memoryIo();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "slock-agent-bridge-stream-burst-"));
  const consumedStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "slock-agent-bridge-consumed-burst-"));
  const priorConsumedStateDir = process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR;
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = consumedStateDir;

  const streamRequests: string[] = [];
  const pollRequests: string[] = [];
  const sse = [
    "event: wake-hint",
    "id: 301",
    "data: {\"event_id\":\"wake-hint:burst-a\",\"message_id\":\"msg-burst-a\",\"seq\":301,\"target\":\"#target-a\",\"wake_reason\":\"message_pending\"}",
    "",
    "event: wake-hint",
    "id: 301",
    "data: {\"event_id\":\"wake-hint:burst-duplicate\",\"message_id\":\"msg-burst-duplicate\",\"seq\":301,\"target\":\"#target-duplicate\",\"wake_reason\":\"message_pending\"}",
    "",
    "event: wake-hint",
    "id: 302",
    "data: {\"event_id\":\"wake-hint:burst-b\",\"message_id\":\"msg-burst-b\",\"seq\":302,\"target\":\"dm:@agent-b\",\"wake_reason\":\"message_pending\"}",
    "",
    "",
  ].join("\n");
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      streamWakeHints: async (query: URLSearchParams) => {
        streamRequests.push(`GET /internal/agent-api/wake-hints/stream?${query.toString()}`);
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sse));
            controller.close();
          },
        });
        return {
          ok: true,
          status: 200,
          error: null,
          response: new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
        };
      },
      request: async (method: string, path: string): Promise<ApiResponse<unknown>> => {
        if (path.includes("/activity")) return { ok: true, status: 200, error: null, data: { ok: true, acceptedCount: 1, rejectedCount: 0, droppedCount: 0 } };
        pollRequests.push(`${method} ${path}`);
        return { ok: false, status: 401, error: "credential revoked", data: null };
      },
    }) as any,
  });

  try {
    await assert.rejects(
      async () => runAgentBridge(ctx, {
        json: true,
        stateDir,
        pollIntervalMs: "1",
      }),
      (err: unknown) => err instanceof CliError && err.code === "BRIDGE_WAKE_HINTS_FAILED",
    );

    assert.deepEqual(streamRequests, [
      "GET /internal/agent-api/wake-hints/stream?since=latest",
    ]);
    assert.deepEqual(pollRequests, [
      "GET /internal/agent-api/wake-hints?since=302&limit=50",
    ]);

    const output = stdout.join("");
    assert.match(output, /"wakeHintId":"wake-hint:burst-a"/);
    assert.match(output, /"wakeHintId":"wake-hint:burst-b"/);
    assert.doesNotMatch(output, /wake-hint:burst-duplicate/);
    assert.equal(
      getConsumedSeq(agentContext.agentId, "#target-a"),
      undefined,
      "stream wake hints must not advance target consumed cursors",
    );
    assert.equal(
      getConsumedSeq(agentContext.agentId, "dm:@agent-b"),
      undefined,
      "stream wake hints must not advance DM consumed cursors",
    );
  } finally {
    if (priorConsumedStateDir === undefined) {
      delete process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR;
    } else {
      process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = priorConsumedStateDir;
    }
  }
});

test("agent bridge treats a stalled wake-hint stream as retryable and falls back to poll catch-up", async () => {
  const { io, stdout, stderr } = memoryIo();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "slock-agent-bridge-stream-idle-"));
  const streamRequests: string[] = [];
  const pollRequests: string[] = [];
  const ctx = createCommandContext({
    io,
    env: { SLOCK_BRIDGE_WAKE_STREAM_IDLE_TIMEOUT_MS: "5" },
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      streamWakeHints: async (query: URLSearchParams) => {
        streamRequests.push(`GET /internal/agent-api/wake-hints/stream?${query.toString()}`);
        const body = new ReadableStream<Uint8Array>();
        return {
          ok: true,
          status: 200,
          error: null,
          response: new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
        };
      },
      request: async (method: string, path: string): Promise<ApiResponse<unknown>> => {
        if (path.includes("/activity")) return { ok: true, status: 200, error: null, data: { ok: true, acceptedCount: 1, rejectedCount: 0, droppedCount: 0 } };
        pollRequests.push(`${method} ${path}`);
        return { ok: false, status: 401, error: "credential revoked", data: null };
      },
    }) as any,
  });

  await assert.rejects(
    async () => runAgentBridge(ctx, {
      json: true,
      stateDir,
      pollIntervalMs: "1",
    }),
    (err: unknown) => err instanceof CliError && err.code === "BRIDGE_WAKE_HINTS_FAILED",
  );

  assert.deepEqual(streamRequests, ["GET /internal/agent-api/wake-hints/stream?since=latest"]);
  assert.deepEqual(pollRequests, ["GET /internal/agent-api/wake-hints?since=latest&limit=50"]);
  assert.match(stdout.join(""), /"type":"bridge_retry"/);
  assert.match(stdout.join(""), /wake-hint stream idle timeout/);
  assert.match(stderr.join(""), /transient failure/);
});

test("agent bridge treats malformed wake-hint stream events as retryable stream failures", async () => {
  const { io, stdout } = memoryIo();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "slock-agent-bridge-stream-parse-"));
  const streamRequests: string[] = [];
  const pollRequests: string[] = [];
  const sse = [
    "event: wake-hint",
    "id: 401",
    "data: {not-json",
    "",
    "",
  ].join("\n");
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      streamWakeHints: async (query: URLSearchParams) => {
        streamRequests.push(`GET /internal/agent-api/wake-hints/stream?${query.toString()}`);
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sse));
            controller.close();
          },
        });
        return {
          ok: true,
          status: 200,
          error: null,
          response: new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
        };
      },
      request: async (method: string, path: string): Promise<ApiResponse<unknown>> => {
        if (path.includes("/activity")) return { ok: true, status: 200, error: null, data: { ok: true, acceptedCount: 1, rejectedCount: 0, droppedCount: 0 } };
        pollRequests.push(`${method} ${path}`);
        return { ok: false, status: 401, error: "credential revoked", data: null };
      },
    }) as any,
  });

  await assert.rejects(
    async () => runAgentBridge(ctx, {
      json: true,
      stateDir,
      pollIntervalMs: "1",
    }),
    (err: unknown) => err instanceof CliError && err.code === "BRIDGE_WAKE_HINTS_FAILED",
  );

  assert.deepEqual(streamRequests, ["GET /internal/agent-api/wake-hints/stream?since=latest"]);
  assert.deepEqual(pollRequests, ["GET /internal/agent-api/wake-hints?since=latest&limit=50"]);
  assert.match(stdout.join(""), /"type":"bridge_retry"/);
  assert.match(stdout.join(""), /wake-hint stream parse failed/);
});

test("agent bridge fails visible when the profile bridge lock is already held", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: true,
        status: 200,
        error: null,
        data: { wake_hints: [], last_hint_seq: null, has_more: false },
      }),
    }) as any,
  });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "slock-agent-bridge-command-"));
  fs.writeFileSync(path.join(stateDir, "bridge.lock"), JSON.stringify({
    ownerId: "other",
    pid: process.pid,
  }));

  await assert.rejects(
    async () => runAgentBridge(ctx, {
      once: true,
      json: true,
      stateDir,
    }),
    /already running/,
  );
});

// --- task #71: D5 backoff-then-degrade for the long-running poll loop.
// Staging deploys restart the server several times a day; the loop used to
// die on the first SERVER_5XX / transport throw, silently ending all wakes
// until the operator restarted CC. ---
import { classifyBridgeLoopError } from "./bridge.js";
import { CliError } from "../../core/errors.js";

test("classifyBridgeLoopError: 5xx and transport throws retry, 4xx and unknown fail closed", () => {
  assert.equal(classifyBridgeLoopError(new CliError({ code: "SERVER_5XX", message: "HTTP 503" })), "retryable");
  assert.equal(classifyBridgeLoopError(new CliError({ code: "BRIDGE_WAKE_HINTS_FAILED", message: "HTTP 401" })), "fatal");
  const fetchFailed = new TypeError("fetch failed");
  assert.equal(classifyBridgeLoopError(fetchFailed), "retryable");
  assert.equal(classifyBridgeLoopError(new TypeError("terminated")), "retryable");
  assert.equal(classifyBridgeLoopError(new Error("connect ECONNREFUSED 127.0.0.1:443")), "retryable");
  assert.equal(classifyBridgeLoopError(new Error("something else entirely")), "fatal");
});

test("bridge loop retries a transient 5xx with backoff, recovers, and fails closed on 4xx", async () => {
  const { io, stdout, stderr } = memoryIo();
  let wakeCall = 0;
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (_method: string, path: string): Promise<ApiResponse<unknown>> => {
        if (path.includes("/activity")) return { ok: true, status: 200, error: null, data: { ok: true, acceptedCount: 1, rejectedCount: 0, droppedCount: 0 } };
        wakeCall += 1;
        if (wakeCall === 1) return { ok: false, status: 503, error: "deploy restart", data: null };
        if (wakeCall === 2) return { ok: true, status: 200, error: null, data: { wake_hints: [], last_hint_seq: null, has_more: false } };
        return { ok: false, status: 401, error: "credential revoked", data: null };
      },
    }) as any,
  });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "slock-agent-bridge-backoff-"));

  await assert.rejects(
    async () => runAgentBridge(ctx, {
      json: true,
      stateDir,
      pollIntervalMs: "1",
    }),
    (err: unknown) => err instanceof CliError && err.code === "BRIDGE_WAKE_HINTS_FAILED",
  );

  assert.equal(wakeCall, 3, "one transient failure, one success, one fatal wake fetch");
  const out = stdout.join("");
  assert.match(out, /"type":"bridge_retry"/);
  assert.match(out, /"consecutiveFailures":1/);
  assert.match(out, /"type":"bridge_recovered"/);
  const errText = stderr.join("");
  assert.match(errText, /transient failure/);
  assert.match(errText, /recovered after 1 transient failure/);
});

test("bridge loop reports fatal bridge errors through agent activity before exit", async () => {
  const { io } = memoryIo();
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path, body });
        if (path.includes("/activity")) {
          return {
            ok: true,
            status: 200,
            error: null,
            data: { ok: true, acceptedCount: 1, rejectedCount: 0, droppedCount: 0 },
          };
        }
        throw new Error("unclassified bridge failure");
      },
    }) as any,
  });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "slock-agent-bridge-fatal-activity-"));

  await assert.rejects(
    async () => runAgentBridge(ctx, {
      stateDir,
      pollIntervalMs: "5",
    }),
    (err: unknown) => err instanceof CliError && err.code === "CHECK_FAILED",
  );

  const activityRequest = requests.find((request) => request.path.includes("/activity"));
  assert.ok(activityRequest, "fatal bridge exit must post an agent activity surface");
  const body = activityRequest.body as any;
  assert.equal(body.schema, "raft-agent-activity-ingest.v1");
  assert.equal(body.events.length, 1);
  assert.equal(body.events[0].hookEventName, "BridgeFatal");
  assert.equal(body.events[0].errorClass, "CHECK_FAILED");
  assert.match(body.events[0].toolOutput, /wakeHintsFetch transport request failed/);

  const log = fs.readFileSync(path.join(stateDir, "bridge.log"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(log.some((entry) => entry.type === "bridge_fatal"));
  assert.ok(log.some((entry) => entry.type === "bridge_fatal_activity_forwarded"));
});

test("bridge --once surfaces even transient errors (debug single-shot)", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({ ok: false, status: 503, error: "down", data: null }),
    }) as any,
  });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "slock-agent-bridge-once-"));
  await assert.rejects(
    async () => runAgentBridge(ctx, { once: true, json: true, stateDir }),
    (err: unknown) => err instanceof CliError && err.code === "SERVER_5XX",
  );
});

test("retry loop replays locally pending hints at most once per process (Stone's #2783 blocker)", async () => {
  const { io } = memoryIo();
  // Local catcher = the Claude channel plugin's wake endpoint; counts POSTs.
  const http = await import("node:http");
  let wakePosts = 0;
  const catcher = http.createServer((req, res) => {
    if (req.method === "POST" && req.url?.startsWith("/wake")) wakePosts += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, runtimeSession: "claude-test" }));
  });
  await new Promise<void>((resolve) => catcher.listen(0, "127.0.0.1", resolve));
  const address = catcher.address() as { port: number };

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "slock-agent-bridge-replay-"));
  // One locally accepted pending hint from a previous bridge run.
  fs.writeFileSync(path.join(stateDir, "wake-hints.jsonl"), `${JSON.stringify({
    event_id: "wake-hint:replay-1",
    message_id: "msg-replay-1",
    seq: 900,
    target: "channelId:chan-1",
    channel_id: "chan-1",
    channel_name: "general",
    channel_type: "channel",
    wake_reason: "message_pending",
  })}\n`);

  let fetches = 0;
  const ctx = createCommandContext({
    io,
    env: { RAFT_CHANNEL_TOKEN: "t" },
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (_method: string, path: string): Promise<ApiResponse<unknown>> => {
        if (path.includes("/activity")) return { ok: true, status: 200, error: null, data: { ok: true, acceptedCount: 1, rejectedCount: 0, droppedCount: 0 } };
        fetches += 1;
        if (fetches <= 2) return { ok: false, status: 503, error: "deploy restart", data: null };
        return { ok: false, status: 401, error: "credential revoked", data: null };
      },
    }) as any,
  });

  try {
    await assert.rejects(
      async () => runAgentBridge(ctx, {
        json: true,
        stateDir,
        pollIntervalMs: "1",
        wakeAdapter: "wake-channel",
        wakeChannelEndpoint: `http://127.0.0.1:${address.port}/wake`,
      }),
      (err: unknown) => err instanceof CliError && err.code === "BRIDGE_WAKE_HINTS_FAILED",
    );
  } finally {
    await new Promise<void>((resolve, reject) => catcher.close((err) => err ? reject(err) : resolve()));
  }

  assert.equal(fetches, 3, "two retryable 503s then the fatal 401");
  assert.equal(wakePosts, 1, "the locally pending hint must be replay-injected exactly once, not once per backoff attempt");
});

test("bridge loop reconciles on interval and tees lifecycle events to bridge.log regardless of --json", async () => {
  const { io, stdout } = memoryIo();
  let mainFetches = 0;
  let reconcileFetches = 0;
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (_method: string, pathname: string): Promise<ApiResponse<unknown>> => {
        if (pathname.includes("since=0")) {
          reconcileFetches += 1;
          return {
            ok: true,
            status: 200,
            error: null,
            data: {
              wake_hints: [{ event_id: "wake-hint:msg-stranded", seq: 700, target: "channelId:channel-1", wake_reason: "message_pending" }],
              last_hint_seq: 700,
              has_more: false,
            },
          };
        }
        mainFetches += 1;
        if (mainFetches >= 10) return { ok: false, status: 401, error: "credential revoked", data: null };
        return { ok: true, status: 200, error: null, data: { wake_hints: [], last_hint_seq: null, has_more: false } };
      },
    }) as any,
  });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "slock-agent-bridge-reconcile-"));

  await assert.rejects(
    async () => runAgentBridge(ctx, {
      stateDir,
      pollIntervalMs: "5",
      reconcileIntervalMs: "30",
    }),
    (err: unknown) => err instanceof CliError && err.code === "BRIDGE_WAKE_HINTS_FAILED",
  );

  assert.ok(reconcileFetches >= 1, "reconcile re-peek (since=0) must fire on the interval");
  assert.equal(stdout.join(""), "", "without --json, protocol events stay off stdout");

  const log = fs.readFileSync(path.join(stateDir, "bridge.log"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
  const types = log.map((entry) => entry.type ?? entry.kind);
  assert.ok(types.includes("bridge_process_started"), `log must record process start, got: ${types.join(",")}`);
  assert.ok(types.includes("reconcile_peek"), `log must record reconcile summaries, got: ${types.join(",")}`);
  assert.ok(types.includes("bridge_fatal"), `log must record the fatal exit reason, got: ${types.join(",")}`);
  const peek = log.find((entry) => entry.type === "reconcile_peek");
  assert.equal(peek.pendingCount, 1);
  for (const entry of log) assert.ok(typeof entry.ts === "string", "every log line carries a timestamp");
});

// Stone's #2805 blocker regression (EAB-7 bounded-time): a healthy-but-quiet
// SSE stream sends only `: ka` comment heartbeats — these used to keep the
// bridge inside the stream read loop forever, starving the reconcile timer.
// Reconciliation must fire (re-peek since=0, re-inject the still-pending
// hint as a REAL wake POST) while the stream stays connected and healthy.
test("reconciliation fires on a healthy idle stream that sends only heartbeats (EAB-7 bounded-time)", async () => {
  const { io } = memoryIo();
  const wakePosts: string[] = [];
  const wakeServer = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.startsWith("/wake")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      wakePosts.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, runtimeSession: "claude-session-ka" }));
    });
  });
  await new Promise<void>((resolve) => wakeServer.listen(0, "127.0.0.1", resolve));
  const wakePort = (wakeServer.address() as { port: number }).port;

  let streamHealthy = true;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      streamWakeHints: async () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(": connected\n\n"));
            heartbeatTimer = setInterval(() => {
              if (!streamHealthy) {
                clearInterval(heartbeatTimer);
                try { controller.close(); } catch { /* already closed */ }
                return;
              }
              try { controller.enqueue(new TextEncoder().encode(": ka\n\n")); } catch { /* closed */ }
            }, 10);
          },
          cancel() {
            if (heartbeatTimer) clearInterval(heartbeatTimer);
          },
        });
        return {
          ok: true,
          status: 200,
          error: null,
          response: new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
        };
      },
      request: async (_method: string, pathname: string): Promise<ApiResponse<unknown>> => {
        if (pathname.includes("since=0")) {
          // Full-pending reconcile peek: one hint that was never consumed.
          return {
            ok: true,
            status: 200,
            error: null,
            data: {
              wake_hints: [{ event_id: "wake-hint:msg-ka", message_id: "msg-ka", seq: 401, target: "channelId:channel-1", wake_reason: "message_pending" }],
              last_hint_seq: 401,
              has_more: false,
            },
          };
        }
        // Poll-mode main fetch only happens after we deliberately end the
        // stream; use it as the fatal exit for the test.
        return { ok: false, status: 401, error: "credential revoked", data: null };
      },
    }) as any,
  });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "slock-agent-bridge-ka-"));

  const run = assert.rejects(
    async () => runAgentBridge(ctx, {
      stateDir,
      pollIntervalMs: "5",
      reconcileIntervalMs: "60",
      wakeAdapter: "wake-channel",
      wakeChannelEndpoint: `http://127.0.0.1:${wakePort}/wake`,
    }),
    (err: unknown) => err instanceof CliError && err.code === "BRIDGE_WAKE_HINTS_FAILED",
  );

  // Wait for the reconcile re-inject to land as a real wake POST while the
  // stream is still healthy (only heartbeats, never a wake event).
  const deadline = Date.now() + 5_000;
  while (wakePosts.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const postsWhileHealthy = wakePosts.length;
  streamHealthy = false; // end the stream -> retryable -> poll mode -> 401 fatal exits the loop
  await run;
  wakeServer.close();

  assert.ok(postsWhileHealthy >= 1, "reconcile must re-inject while the stream is healthy, not only after disconnect");
  assert.match(wakePosts[0]!, /msg-ka/);
  const log = fs.readFileSync(path.join(stateDir, "bridge.log"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
  const peek = log.find((entry) => entry.type === "reconcile_peek");
  assert.ok(peek, "reconcile_peek must be logged on the idle-stream path");
  assert.equal(peek.pendingCount, 1);
  assert.equal(peek.reinjectedCount, 1);
});

test("RED: without fast reconcile, unconsumed hints wait for the full reconcile interval (delivery gap)", async () => {
  const { io } = memoryIo();
  let mainFetches = 0;
  let reconcileFetches = 0;
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (_method: string, pathname: string): Promise<ApiResponse<unknown>> => {
        if (pathname.includes("since=0")) {
          reconcileFetches += 1;
          return {
            ok: true, status: 200, error: null,
            data: {
              wake_hints: [{ event_id: "wake-hint:still-pending", seq: 800, target: "channelId:channel-1", wake_reason: "message_pending" }],
              last_hint_seq: 800,
              has_more: false,
            },
          };
        }
        mainFetches += 1;
        if (mainFetches === 1) {
          return {
            ok: true, status: 200, error: null,
            data: {
              wake_hints: [{ event_id: "wake-hint:first-wake", seq: 800, target: "channelId:channel-1", wake_reason: "message_pending" }],
              last_hint_seq: 800,
              has_more: false,
            },
          };
        }
        if (mainFetches >= 15) return { ok: false, status: 401, error: "credential revoked", data: null };
        return { ok: true, status: 200, error: null, data: { wake_hints: [], last_hint_seq: null, has_more: false } };
      },
    }) as any,
  });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "slock-agent-bridge-no-fast-reconcile-"));

  await assert.rejects(
    async () => runAgentBridge(ctx, {
      stateDir,
      pollIntervalMs: "5",
      reconcileIntervalMs: "600000",
      fastReconcileDelayMs: "0",
    }),
    (err: unknown) => err instanceof CliError && err.code === "BRIDGE_WAKE_HINTS_FAILED",
  );

  assert.equal(reconcileFetches, 0, "without fast reconcile and with a 600s regular interval, no reconcile fires — unconsumed hints are stuck");
  const log = fs.readFileSync(path.join(stateDir, "bridge.log"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
  const anyReconcile = log.find((entry: any) => entry.type === "reconcile_peek" || entry.type === "fast_reconcile_peek");
  assert.equal(anyReconcile, undefined, "no reconcile event in log — this is the delivery gap that fast reconcile fixes");
});

test("GREEN: fast reconcile fires shortly after processing wake hints (delivery stability)", async () => {
  const { io } = memoryIo();
  let mainFetches = 0;
  let reconcileFetches = 0;
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (_method: string, pathname: string): Promise<ApiResponse<unknown>> => {
        if (pathname.includes("since=0")) {
          reconcileFetches += 1;
          return {
            ok: true,
            status: 200,
            error: null,
            data: {
              wake_hints: [{ event_id: "wake-hint:still-pending", seq: 800, target: "channelId:channel-1", wake_reason: "message_pending" }],
              last_hint_seq: 800,
              has_more: false,
            },
          };
        }
        mainFetches += 1;
        if (mainFetches === 1) {
          return {
            ok: true, status: 200, error: null,
            data: {
              wake_hints: [{ event_id: "wake-hint:first-wake", seq: 800, target: "channelId:channel-1", wake_reason: "message_pending" }],
              last_hint_seq: 800,
              has_more: false,
            },
          };
        }
        if (mainFetches >= 15) return { ok: false, status: 401, error: "credential revoked", data: null };
        return { ok: true, status: 200, error: null, data: { wake_hints: [], last_hint_seq: null, has_more: false } };
      },
    }) as any,
  });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "slock-agent-bridge-fast-reconcile-"));

  await assert.rejects(
    async () => runAgentBridge(ctx, {
      stateDir,
      pollIntervalMs: "5",
      reconcileIntervalMs: "600000",
      fastReconcileDelayMs: "15",
    }),
    (err: unknown) => err instanceof CliError && err.code === "BRIDGE_WAKE_HINTS_FAILED",
  );

  assert.ok(reconcileFetches >= 1, "fast reconcile (since=0) must fire shortly after processing wake hints, not wait for the 600s regular interval");
  const log = fs.readFileSync(path.join(stateDir, "bridge.log"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
  const fastPeek = log.find((entry: any) => entry.type === "fast_reconcile_peek");
  assert.ok(fastPeek, `fast_reconcile_peek event must appear in log, got types: ${log.map((e: any) => e.type).join(",")}`);
  assert.ok(fastPeek.pendingCount >= 1, "fast reconcile must see the still-pending hint");
  assert.ok(fastPeek.reinjectedCount >= 1, "fast reconcile must re-inject the unconsumed hint");
});

test("wake-channel is the only adapter kind; old names fail closed", async () => {
  // Pure-break rename (task #99 / plugin 0.2.0): one protocol name across
  // every runtime plugin. Wire: x-raft-bridge-token + raft-channel-wake.v1.
  const wakes: string[] = [];
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.startsWith("/wake")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const schema = (JSON.parse(body) as { schema?: string }).schema ?? "none";
      wakes.push(`${req.headers["x-raft-bridge-token"]}:${schema}:${body.includes("content") ? "LEAK" : "content-free"}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, runtimeSession: "raft-session-1" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: true,
        status: 200,
        error: null,
        data: {
          wake_hints: [{ event_id: "wake-hint:rc-1", message_id: "msg-rc", seq: 951, target: "channelId:channel-1", wake_reason: "message_pending", content: "must not leak" }],
          last_hint_seq: 951,
          has_more: false,
        },
      }),
    }) as any,
  });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "slock-agent-bridge-rc-"));
  try {
    await runAgentBridge(ctx, {
      once: true,
      stateDir,
      wakeAdapter: "wake-channel",
      wakeChannelEndpoint: `http://127.0.0.1:${port}/wake`,
      wakeChannelToken: "rc-token",
    });
    assert.deepEqual(wakes, ["rc-token:raft-channel-wake.v1:content-free"], "raft-channel kind must drive the renamed wire contract");

    for (const old of ["raft-channel", "wake-endpoint", "claude-code-channels", "bogus"]) {
      await assert.rejects(
        async () => runAgentBridge(ctx, { once: true, stateDir, wakeAdapter: old }),
        (err: unknown) => err instanceof CliError && err.code === "INVALID_ARG" && /wake-channel/.test(err.message),
        `old/unknown kind '${old}' must fail closed`,
      );
    }
  } finally {
    server.close();
  }
});
