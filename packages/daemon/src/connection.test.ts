/**
 * Tests for DaemonConnection liveness watchdog behaviour.
 *
 * Uses a fake WebSocket factory so no real network is required.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";
import { classifyDaemonConnectionTraceEvent, DaemonConnection } from "./connection";
import type { Clock } from "./connection";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { createTraceClient, LocalRotatingTraceSink } from "@botiverse/raft-trace-client";
import type { MachineToServerMessage, ServerToMachineMessage, Tracer, TraceStatus } from "@botiverse/raft-shared";
import { FakeClock } from "./testing/drydock";
import { subscribeDaemonLogs } from "./logger";

type WebSocketOptions = import("ws").ClientOptions;

// ---------------------------------------------------------------------------
// Fake WebSocket
// ---------------------------------------------------------------------------
class FakeWebSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  terminated = false;
  closed = false;
  sent: string[] = [];

  send(data: string) {
    this.sent.push(data);
  }

  terminate() {
    if (this.terminated || this.closed) return;
    this.terminated = true;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", 1006, Buffer.from(""));
  }

  close(code = 1000, reason = "") {
    if (this.terminated || this.closed) return;
    this.closed = true;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code, Buffer.from(reason));
  }

  /** Simulate a message arriving from the server. */
  receiveMessage(msg: ServerToMachineMessage) {
    this.emit("message", Buffer.from(JSON.stringify(msg)));
  }

  /** Simulate a server-side close (no outstanding pong). */
  serverClose(code = 1000) {
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code, Buffer.from(""));
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeConnection(opts: {
  serverUrl?: string;
  onMessage?: (m: ServerToMachineMessage) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onTraceEvent?: (name: string, attrs?: Record<string, unknown>, status?: TraceStatus) => void;
  inboundWatchdogMs?: number;
  connectTimeoutMs?: number;
  minReconnectDelayMs?: number;
  proxyEnv?: NodeJS.ProcessEnv;
  clock?: Clock;
  autoOpen?: boolean;
  tracer?: Tracer;
} = {}): {
  conn: DaemonConnection;
  getWs: () => FakeWebSocket;
  getAllWs: () => FakeWebSocket[];
  getWsOptions: () => WebSocketOptions | undefined;
  getWsUrl: () => string | undefined;
} {
  let currentWs: FakeWebSocket;
  const allWs: FakeWebSocket[] = [];
  let currentWsOptions: WebSocketOptions | undefined;
  let currentWsUrl: string | undefined;

  const conn = new DaemonConnection({
    reconnectDelayFor: (backoffMs: number) => backoffMs,
    serverUrl: opts.serverUrl ?? "http://localhost:9999",
    apiKey: "sk_machine_test",
    onMessage: opts.onMessage ?? (() => {}),
    onConnect: opts.onConnect ?? (() => {}),
    onDisconnect: opts.onDisconnect ?? (() => {}),
    onTraceEvent: opts.onTraceEvent,
    tracer: opts.tracer,
    inboundWatchdogMs: opts.inboundWatchdogMs ?? 50,
    connectTimeoutMs: opts.connectTimeoutMs,
    minReconnectDelayMs: opts.minReconnectDelayMs ?? 1000,
    proxyEnv: opts.proxyEnv,
    clock: opts.clock,
    wsFactory: (url: string, options) => {
      currentWsUrl = url;
      currentWsOptions = options;
      currentWs = new FakeWebSocket();
      allWs.push(currentWs);
      // Emit open asynchronously by default, as a real WebSocket would. Tests
      // that need deterministic timer control can emit it explicitly instead.
      if (opts.autoOpen !== false) setImmediate(() => currentWs.emit("open"));
      return currentWs as unknown as WebSocket;
    },
  });

  return {
    conn,
    getWs: () => currentWs,
    getAllWs: () => allWs,
    getWsOptions: () => currentWsOptions,
    getWsUrl: () => currentWsUrl,
  };
}

/** Send `ready` the way DaemonCore does; status/activity replay waits for it (RFC 069 §8). */
function sendReady(conn: DaemonConnection) {
  conn.send({ type: "ready", capabilities: [], runtimes: [], runningAgents: [] } as unknown as MachineToServerMessage);
}

/** Wait for the open event to have fired (i.e., the watchdog to have started). */
async function waitForOpen() {
  await new Promise((r) => setTimeout(r, 10));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("watchdog probes after inboundWatchdogMs and terminates only if the probe is unanswered", () => {
  const clock = new FakeClock();
  const disconnects: number[] = [];
  const { conn, getWs } = makeConnection({
    onDisconnect: () => disconnects.push(clock.now()),
    inboundWatchdogMs: 60,
    clock,
    autoOpen: false,
  });

  conn.connect();
  const ws = getWs();
  ws.emit("open");
  assert.equal(ws.terminated, false, "should not be terminated immediately after open");

  clock.advanceBy(59);
  assert.equal(ws.sent.length, 0, "watchdog should not probe before the inbound deadline");

  clock.advanceBy(1);
  assert.equal(ws.terminated, false, "first watchdog deadline should send a liveness probe, not reconnect");
  assert.deepEqual(JSON.parse(ws.sent.at(-1) ?? "{}"), { type: "ping" });
  assert.equal(disconnects.length, 0, "onDisconnect should not fire before the probe window elapses");

  clock.advanceBy(60);
  assert.equal(ws.terminated, true, "unanswered watchdog probe should call terminate()");
  assert.equal(disconnects.length >= 1, true, "onDisconnect should have been called");

  conn.disconnect();
});

test("daemon websocket auth uses Authorization header instead of query string", async () => {
  const { conn, getWsUrl, getWsOptions } = makeConnection({
    serverUrl: "https://api.slock.ai",
  });

  conn.connect();
  await waitForOpen();

  assert.equal(getWsUrl(), "wss://api.slock.ai/daemon/connect");
  assert.deepEqual(getWsOptions()?.headers, { Authorization: "Bearer sk_machine_test" });
  assert.equal(getWsUrl()?.includes("sk_machine_test"), false);

  conn.disconnect();
});

test("DaemonConnection bounds a hung websocket handshake and reconnects on the production default timeout", () => {
  const clock = new FakeClock();
  const traceEvents: Array<{ name: string; attrs?: Record<string, unknown>; status?: TraceStatus }> = [];
  const disconnects: number[] = [];
  const { conn, getWs, getAllWs } = makeConnection({
    clock,
    autoOpen: false,
    minReconnectDelayMs: 10,
    onDisconnect: () => disconnects.push(clock.now()),
    onTraceEvent: (name, attrs, status) => traceEvents.push({ name, attrs, status }),
  });

  conn.connect();
  const hungWs = getWs();
  hungWs.readyState = WebSocket.CONNECTING;

  clock.advanceBy(29_999);
  conn.connect();
  assert.equal(getAllWs().length, 1, "a hung CONNECTING socket still owns the reconnect slot before the deadline");
  assert.equal(hungWs.terminated, false, "the production default deadline should not fire early");

  clock.advanceBy(1);
  assert.equal(hungWs.terminated, true, "the timed-out CONNECTING socket must be terminated");
  assert.equal(hungWs.readyState, WebSocket.CLOSED, "the timed-out socket must leave CONNECTING");
  assert.deepEqual(disconnects, [30_000], "timeout-driven close should report one disconnect");
  assert.equal(getAllWs().length, 1, "the retry should wait for the configured reconnect delay");

  const timeoutTrace = traceEvents.find((event) => event.name === "daemon.connection.handshake_timeout");
  assert.equal(timeoutTrace?.status, "error");
  assert.equal(timeoutTrace?.attrs?.connect_timeout_ms, 30_000);
  assert.equal(timeoutTrace?.attrs?.ws_ready_state, WebSocket.CONNECTING);

  clock.advanceBy(10);
  assert.equal(getAllWs().length, 2, "the hung connect attempt must advance to attempt 2 after timeout plus backoff");

  conn.disconnect();
});

test("DaemonConnection connect timeout is cleared on open and disconnect", () => {
  const clock = new FakeClock();
  const { conn: openedConn, getWs: getOpenedWs, getAllWs: getOpenedSockets } = makeConnection({
    clock,
    autoOpen: false,
    inboundWatchdogMs: 1_000,
    connectTimeoutMs: 30,
    minReconnectDelayMs: 10,
  });

  openedConn.connect();
  const openingWs = getOpenedWs();
  openingWs.readyState = WebSocket.CONNECTING;
  clock.advanceBy(29);
  openingWs.readyState = WebSocket.OPEN;
  openingWs.emit("open");
  clock.advanceBy(100);
  assert.equal(openingWs.terminated, false, "opening before the deadline must clear the connect timeout");
  assert.equal(getOpenedSockets().length, 1, "a stale connect timer must not create a replacement after open");
  openedConn.disconnect();

  const stopClock = new FakeClock();
  const { conn: stoppedConn, getWs: getStoppedWs, getAllWs: getStoppedSockets } = makeConnection({
    clock: stopClock,
    autoOpen: false,
    inboundWatchdogMs: 1_000,
    connectTimeoutMs: 30,
    minReconnectDelayMs: 10,
  });

  stoppedConn.connect();
  const stoppedWs = getStoppedWs();
  stoppedWs.readyState = WebSocket.CONNECTING;
  stopClock.advanceBy(10);
  stoppedConn.disconnect();
  stopClock.advanceBy(100);
  assert.equal(stoppedWs.closed, true, "disconnect before the deadline should close the in-flight socket");
  assert.equal(stoppedWs.terminated, false, "disconnect should not be reclassified as a handshake timeout");
  assert.equal(getStoppedSockets().length, 1, "a cleared connect timeout must not restart after disconnect");
});

test("DaemonConnection emits diagnostic trace events for connect drops and reconnect", async () => {
  const traceEvents: Array<{ name: string; attrs?: Record<string, unknown>; status?: TraceStatus }> = [];
  const sink = new MemoryTraceSink();
  const { conn, getWs } = makeConnection({
    onTraceEvent: (name, attrs, status) => traceEvents.push({ name, attrs, status }),
    tracer: new BasicTracer({ sink }),
    inboundWatchdogMs: 60,
  });

  conn.send({ type: "pong" });
  conn.connect();
  await waitForOpen();
  getWs().serverClose(1006);

  assert.deepEqual(
    traceEvents.map((event) => event.name),
    [
      "daemon.connection.outbound_dropped",
      "daemon.connection.disconnected",
      "daemon.connection.reconnect_scheduled",
    ],
  );
  assert.equal(traceEvents[0].attrs?.outbound_message_kind, "pong");
  assert.equal(traceEvents[0].attrs?.reason, "not_replayable");
  const [connectSpan] = sink.getAllSpans().filter((span) => span.name === "daemon.connection.connect");
  assert.equal(connectSpan?.status, "ok");
  assert.equal(connectSpan?.attrs?.server_url_present, true);
  assert.equal(connectSpan?.attrs?.reconnect_attempt, 0);
  assert.equal(connectSpan?.attrs?.outcome, "connected");
  assert.equal(traceEvents[1].attrs?.close_code, 1006);
  assert.equal(traceEvents[1].attrs?.reconnecting, true);
  assert.equal(traceEvents[1].status, "cancelled");
  assert.equal(traceEvents[2].attrs?.reconnect_attempt, 1);
  const reconnectClassification = classifyDaemonConnectionTraceEvent(traceEvents[2].name, traceEvents[2].attrs);
  assert.equal(reconnectClassification?.eventClass, "control_plane_reconnect");
  assert.equal(reconnectClassification?.shouldAffectRuntimeState, false);

  conn.disconnect();
});

test("DaemonConnection records non-ping inbound messages with closed message kind", async () => {
  const sink = new MemoryTraceSink();
  const { conn, getWs } = makeConnection({
    tracer: new BasicTracer({ sink }),
    inboundWatchdogMs: 60,
  });

  conn.connect();
  await waitForOpen();
  getWs().receiveMessage({ type: "agent:start" } as unknown as ServerToMachineMessage);

  const inbound = sink.getAllSpans().find((span) => span.name === "daemon.connection.inbound");
  assert.equal(inbound?.status, "ok");
  assert.equal(inbound?.kind, "consumer");
  assert.equal(inbound?.attrs?.inbound_message_kind, "agent:start");
  assert.equal(Object.hasOwn(inbound?.attrs ?? {}, "message_type"), false);

  conn.disconnect();
});

test("the daemon fact id never reaches the local trace file through daemon.agent.activity.sent (task #423)", async () => {
  // Real LocalRotatingTraceSink + JSONL read-back: the fact id is scrubbed as
  // producer_fact_id by the sink, so the only way it can land is under another
  // allowed key. Before this fix it did, as correlation_id.
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-sent-correlation-"));
  try {
    const tracer = createTraceClient({
      source: "daemon",
      sinks: [new LocalRotatingTraceSink({ machineDir, maxFileBytes: 1024 * 1024, maxFiles: 4 })],
    });
    const { conn } = makeConnection({
      // Same wiring as DaemonCore.recordDaemonEvent.
      onTraceEvent: (name, attrs, status) => tracer.emitEvent(name, { surface: "daemon", attrs: { ...attrs, status } }),
      inboundWatchdogMs: 60,
    });
    const factId = "daemon_activity:agent-1:launch-1:7";
    conn.connect();
    await waitForOpen();
    sendReady(conn);
    conn.send({
      type: "agent:activity",
      agentId: "agent-1",
      activity: "working",
      detail: "",
      launchId: "launch-1",
      clientSeq: 7,
      producerFactId: factId,
    });
    conn.disconnect();

    const dir = path.join(machineDir, "traces");
    const raw = (await Promise.all((await readdir(dir)).map((file) => readFile(path.join(dir, file), "utf8")))).join("\n");
    const sent = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { name?: string; attrs?: Record<string, unknown> })
      .filter((record) => record.name === "daemon.agent.activity.sent");
    assert.equal(sent.length, 1, "the sent span must reach the file (positive control)");
    assert.equal(sent[0]!.attrs?.correlation_id, "agent:agent-1:daemonActivity:launch-1:7");
    assert.equal(raw.includes(factId), false, "the fact id must not appear anywhere in the trace file");
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("DaemonConnection traces agent:activity sent spans with emit-side join keys", async () => {
  const traceEvents: Array<{ name: string; attrs?: Record<string, unknown>; status?: TraceStatus }> = [];
  const { conn, getWs } = makeConnection({
    onTraceEvent: (name, attrs, status) => traceEvents.push({ name, attrs, status }),
    inboundWatchdogMs: 60,
  });

  const activity: MachineToServerMessage = {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "Tool call",
    entries: [{ kind: "tool_start", toolName: "Bash", toolInput: "echo ok" }],
    launchId: "launch-1",
    clientSeq: 7,
    producerFactId: "daemon_activity:agent-1:launch-1:7",
  };

  conn.connect();
  await waitForOpen();
  sendReady(conn);
  conn.send(activity);

  const sent = traceEvents.find((event) => event.name === "daemon.agent.activity.sent");
  assert.ok(sent, "expected agent:activity.sent trace for open websocket send");
  assert.equal(sent.attrs?.agent_id, "agent-1");
  assert.equal(sent.attrs?.launch_id, "launch-1");
  assert.equal(sent.attrs?.launch_id_present, true);
  assert.equal(sent.attrs?.client_seq, 7);
  assert.equal(sent.attrs?.client_seq_present, true);
  // #422 item 3: neither the fact id nor a flag about it is emitted any more.
  // The wire message still carries it (see `activity` above), so this asserts
  // the emit site drops it rather than the fixture simply not supplying it.
  assert.ok(!("producer_fact_id" in (sent.attrs ?? {})), "the fact id is a banned join key (#460)");
  assert.ok(!("producerFactId" in (sent.attrs ?? {})), "…in either spelling");
  assert.ok(
    !("producer_fact_id_present" in (sent.attrs ?? {})),
    "and a flag for a scrubbed value would claim a field the record does not carry",
  );
  // The fact id is a banned join key (#460): correlation_id must never carry
  // it, whatever the wire message holds (task #423).
  assert.equal(sent.attrs?.correlation_id, "agent:agent-1:daemonActivity:launch-1:7");
  assert.equal(sent.attrs?.entry_kinds, "tool_start");
  assert.equal(sent.attrs?.send_path, "websocket_open");

  const raw = JSON.parse(getWs().sent.at(-1) ?? "{}") as MachineToServerMessage;
  assert.equal(raw.type, "agent:activity");
  if (raw.type === "agent:activity") {
    assert.equal(raw.producerFactId, "daemon_activity:agent-1:launch-1:7");
    assert.equal(raw.launchId, "launch-1");
    assert.equal(raw.clientSeq, 7);
  }

  conn.disconnect();
});

test("DaemonConnection logs Slock-Reason for rejected WebSocket handshakes", async () => {
  const logs: string[] = [];
  const traceEvents: Array<{ name: string; attrs?: Record<string, unknown>; status?: TraceStatus }> = [];
  const rejections: Array<{ statusCode: number; reason: string | null }> = [];
  const unsubscribe = subscribeDaemonLogs((event) => logs.push(event.message));

  class RejectingWebSocket extends EventEmitter {
    readyState: number = WebSocket.CONNECTING;
    send() {}
    close() {
      this.terminate();
    }
    terminate() {
      if (this.readyState === WebSocket.CLOSED) return;
      this.readyState = WebSocket.CLOSED;
      this.emit("close", 1006, Buffer.from(""));
    }
  }

  try {
    const conn = new DaemonConnection({
    reconnectDelayFor: (backoffMs: number) => backoffMs,
      serverUrl: "http://localhost:9999",
      apiKey: "sk_machine_secret_should_not_log",
      onMessage: () => {},
      onConnect: () => {},
      onDisconnect: () => {},
      onHandshakeRejected: (event) => rejections.push(event),
      onTraceEvent: (name, attrs, status) => traceEvents.push({ name, attrs, status }),
      minReconnectDelayMs: 60_000,
      wsFactory: () => {
        const ws = new RejectingWebSocket();
        setImmediate(() => {
          ws.emit("unexpected-response", {}, {
            statusCode: 401,
            headers: { "slock-reason": "computer_revoked" },
            resume() {},
          });
        });
        return ws as unknown as WebSocket;
      },
    });

    conn.connect();
    await new Promise((resolve) => setTimeout(resolve, 10));
    conn.disconnect();
  } finally {
    unsubscribe();
  }

  assert.ok(
    logs.some((message) => message.includes("WebSocket handshake rejected (status=401, slock_reason=computer_revoked)")),
    "expected local log to include the closed-set Slock-Reason",
  );
  assert.equal(logs.some((message) => message.includes("sk_machine_secret_should_not_log")), false);
  assert.deepEqual(rejections, [{ statusCode: 401, reason: "computer_revoked" }]);
  assert.deepEqual(
    traceEvents.find((event) => event.name === "daemon.connection.handshake_rejected"),
    {
      name: "daemon.connection.handshake_rejected",
      attrs: {
        status_code: 401,
        slock_reason_present: true,
        slock_reason: "computer_revoked",
        cf_pop: null,
      },
      status: "error",
    },
  );
  assert.ok(
    traceEvents.some((event) => event.name === "daemon.connection.reconnect_scheduled"),
    "non-migrated handshake rejections keep the existing reconnect behavior",
  );
  assert.equal(traceEvents.some((event) => event.name === "daemon.connection.reconnect_stopped"), false);
});

test("a 429 before the WebSocket opens backs the daemon off exponentially (the backoff is only reset by an open)", async () => {
  const backoffs: number[] = [];
  class RateLimitedWebSocket extends EventEmitter {
    readyState: number = WebSocket.CONNECTING;
    send() {}
    close() { this.terminate(); }
    terminate() {
      if (this.readyState === WebSocket.CLOSED) return;
      this.readyState = WebSocket.CLOSED;
      this.emit("close", 1006, Buffer.from(""));
    }
  }
  const conn = new DaemonConnection({
    reconnectDelayFor: () => 1,
    serverUrl: "http://localhost:9999",
    apiKey: "sk_machine_rate_limited",
    onMessage: () => {},
    onConnect: () => {},
    onDisconnect: () => {},
    onTraceEvent: (name, attrs) => {
      if (name === "daemon.connection.reconnect_scheduled") backoffs.push(Number(attrs?.backoff_ms));
    },
    minReconnectDelayMs: 1000,
    wsFactory: () => {
      const ws = new RateLimitedWebSocket();
      setImmediate(() => {
        ws.emit("unexpected-response", {}, {
          statusCode: 429,
          headers: { "retry-after": "30", "slock-reason": "connect_rate_limited" },
          resume() {},
        });
      });
      return ws as unknown as WebSocket;
    },
  });
  conn.connect();
  const deadline = Date.now() + 2_000;
  while (backoffs.length < 6 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  conn.disconnect();
  assert.deepEqual(backoffs.slice(0, 6), [1000, 2000, 4000, 8000, 16000, 30000], "each refused handshake doubles the wait up to the 30 s cap");
});

test("DaemonConnection stops retrying a migrated legacy key and prints setup recovery guidance", async () => {
  const logs: string[] = [];
  const traceEvents: Array<{ name: string; attrs?: Record<string, unknown>; status?: TraceStatus }> = [];
  const clock = new FakeClock();
  const sockets: RejectingMigratedKeyWebSocket[] = [];
  const unsubscribe = subscribeDaemonLogs((event) => logs.push(event.message));

  class RejectingMigratedKeyWebSocket extends EventEmitter {
    readyState: number = WebSocket.CONNECTING;
    send() {}
    close() {
      this.terminate();
    }
    terminate() {
      if (this.readyState === WebSocket.CLOSED) return;
      this.readyState = WebSocket.CLOSED;
      this.emit("close", 1006, Buffer.from(""));
    }
  }

  const conn = new DaemonConnection({
    reconnectDelayFor: (backoffMs: number) => backoffMs,
    serverUrl: "http://localhost:9999",
    apiKey: "sk_machine_migrated",
    onMessage: () => {},
    onConnect: () => {},
    onDisconnect: () => {},
    onTraceEvent: (name, attrs, status) => traceEvents.push({ name, attrs, status }),
    minReconnectDelayMs: 1000,
    clock,
    wsFactory: () => {
      const ws = new RejectingMigratedKeyWebSocket();
      sockets.push(ws);
      setImmediate(() => {
        ws.emit("unexpected-response", {}, {
          statusCode: 401,
          headers: { "slock-reason": "legacy_machine_key_migrated" },
          resume() {},
        });
      });
      return ws as unknown as WebSocket;
    },
  });

  try {
    conn.connect();
    await new Promise<void>((resolve) => setImmediate(resolve));
    clock.advanceBy(120_000);

    assert.equal(sockets.length, 1, "a migrated key must not open another websocket after the terminal rejection");
    assert.ok(
      logs.some((message) => message.includes("Reconnects are stopped because this key cannot authenticate again")),
      "expected terminal retry guidance",
    );
    assert.ok(
      logs.some((message) => message.includes("raft-computer: command not found? Install or re-run setup")),
      "expected a recovery path that does not assume raft-computer is installed",
    );
    assert.deepEqual(
      traceEvents.find((event) => event.name === "daemon.connection.reconnect_stopped"),
      {
        name: "daemon.connection.reconnect_stopped",
        attrs: {
          status_code: 401,
          slock_reason: "legacy_machine_key_migrated",
          terminal: true,
        },
        status: "error",
      },
    );
  } finally {
    conn.disconnect();
    unsubscribe();
  }
});

test("DaemonConnection passes proxy-backed options into the websocket factory", async () => {
  const { conn, getWsOptions } = makeConnection({
    proxyEnv: {
      HTTP_PROXY: "http://proxy.internal:8080",
    },
  });

  conn.connect();
  await waitForOpen();

  const options = getWsOptions();
  assert.ok(options);
  assert.ok(options.agent instanceof HttpsProxyAgent);

  conn.disconnect();
});

test("DaemonConnection bypasses proxy when NO_PROXY matches the websocket target", async () => {
  const { conn, getWsOptions } = makeConnection({
    serverUrl: "http://localhost:9999",
    proxyEnv: {
      HTTP_PROXY: "http://proxy.internal:8080",
      NO_PROXY: "localhost",
    },
  });

  conn.connect();
  await waitForOpen();

  const options = getWsOptions();
  assert.ok(options);
  assert.equal(options.agent, undefined);
  assert.deepEqual(options.headers, { Authorization: "Bearer sk_machine_test" });

  conn.disconnect();
});

test("watchdog reconnect path is deterministic with FakeClock", async () => {
  const clock = new FakeClock();
  const sockets: FakeWebSocket[] = [];
  let connectCount = 0;
  let disconnectCount = 0;

  const conn = new DaemonConnection({
    reconnectDelayFor: (backoffMs: number) => backoffMs,
    serverUrl: "http://localhost:9999",
    apiKey: "sk_machine_test",
    onMessage: () => {},
    onConnect: () => { connectCount++; },
    onDisconnect: () => { disconnectCount++; },
    inboundWatchdogMs: 70_000,
    minReconnectDelayMs: 1_000,
    clock,
    wsFactory: () => {
      const ws = new FakeWebSocket();
      sockets.push(ws);
      return ws as unknown as WebSocket;
    },
  });

  conn.connect();
  assert.equal(sockets.length, 1, "initial connect should create one socket");
  sockets[0].emit("open");
  assert.equal(connectCount, 1, "initial open should fire onConnect");

  clock.advanceBy(69_999);
  assert.equal(sockets[0].terminated, false, "watchdog should not fire before threshold");
  assert.equal(disconnectCount, 0, "disconnect should not fire before threshold");

  clock.advanceBy(1);
  assert.equal(sockets[0].terminated, false, "watchdog should probe the stale socket first");
  assert.deepEqual(JSON.parse(sockets[0].sent.at(-1) ?? "{}"), { type: "ping" });
  assert.equal(disconnectCount, 0, "probe should not flow into disconnect handling");

  clock.advanceBy(70_000);
  assert.equal(sockets[0].terminated, true, "watchdog should terminate the stale socket after unanswered probe");
  assert.equal(disconnectCount, 1, "terminate should flow into disconnect handling");

  clock.advanceBy(999);
  assert.equal(sockets.length, 1, "reconnect should not happen before backoff elapses");

  clock.advanceBy(1);
  assert.equal(sockets.length, 2, "reconnect should create a new socket after backoff");
  sockets[1].emit("open");
  assert.equal(connectCount, 2, "reconnected socket should fire onConnect again");

  conn.disconnect();
});

test("watchdog timeout traces last inbound message kind and age", async () => {
  const clock = new FakeClock();
  const sockets: FakeWebSocket[] = [];
  const traceEvents: Array<{ name: string; attrs?: Record<string, unknown>; status?: TraceStatus }> = [];

  const conn = new DaemonConnection({
    reconnectDelayFor: (backoffMs: number) => backoffMs,
    serverUrl: "http://localhost:9999",
    apiKey: "sk_machine_test",
    onMessage: () => {},
    onConnect: () => {},
    onDisconnect: () => {},
    onTraceEvent: (name, attrs, status) => traceEvents.push({ name, attrs, status }),
    inboundWatchdogMs: 70_000,
    minReconnectDelayMs: 1_000,
    clock,
    wsFactory: () => {
      const ws = new FakeWebSocket();
      sockets.push(ws);
      return ws as unknown as WebSocket;
    },
  });

  conn.connect();
  sockets[0].emit("open");
  clock.advanceBy(40_000);
  sockets[0].receiveMessage({ type: "ping" });
  clock.advanceBy(69_999);
  assert.equal(sockets[0].terminated, false, "ping should reset watchdog window");

  clock.advanceBy(1);
  assert.equal(sockets[0].terminated, false, "first stale-inbound deadline should send a liveness probe");
  assert.deepEqual(JSON.parse(sockets[0].sent.at(-1) ?? "{}"), { type: "ping" });

  clock.advanceBy(70_000);

  const inbound = traceEvents.find((event) => event.name === "daemon.connection.inbound_received");
  assert.equal(inbound, undefined, "normal ping messages should not emit per-message inbound spans");
  const probe = traceEvents.find((event) => event.name === "daemon.connection.inbound_probe_sent");
  assert.equal(probe?.attrs?.last_inbound_message_kind, "ping");
  assert.equal(probe?.attrs?.last_inbound_age_ms_bucket, "60s-120s");
  const timeout = traceEvents.find((event) => event.name === "daemon.connection.watchdog_timeout");
  assert.equal(timeout?.status, "error");
  assert.equal(timeout?.attrs?.probe_in_flight, true);
  assert.equal(timeout?.attrs?.last_inbound_message_kind, "ping");
  assert.equal(timeout?.attrs?.last_inbound_age_ms_bucket, "120s+");
  assert.equal(timeout?.attrs?.ws_ready_state, WebSocket.OPEN);
  const disconnect = traceEvents.find((event) => event.name === "daemon.connection.disconnected");
  assert.equal(disconnect?.attrs?.close_code, 1006);
  assert.equal(disconnect?.attrs?.last_inbound_message_kind, "ping");
  assert.equal(disconnect?.attrs?.last_inbound_age_ms_bucket, "120s+");

  conn.disconnect();
});

test("connect and disconnect traces carry the CloudFront PoP of that connection, null without the header", async () => {
  const clock = new FakeClock();
  const traceEvents: Array<{ name: string; attrs?: Record<string, unknown>; status?: TraceStatus }> = [];
  const logs: string[] = [];
  const unsubscribe = subscribeDaemonLogs((event) => logs.push(event.message));
  const sink = new MemoryTraceSink();
  const { conn, getAllWs } = makeConnection({
    onTraceEvent: (name, attrs, status) => traceEvents.push({ name, attrs, status }),
    tracer: new BasicTracer({ sink }),
    inboundWatchdogMs: 70_000,
    clock,
    autoOpen: false,
  });
  const upgrade = (ws: FakeWebSocket, headers: Record<string, string>) => ws.emit("upgrade", { headers });

  try {
    conn.connect();
    upgrade(getAllWs()[0], { "x-amz-cf-pop": "NRT57-P7" });
    getAllWs()[0].emit("open");
    assert.equal(conn.cfPop, "NRT57-P7");
    clock.advanceBy(140_000);

    const probe = traceEvents.find((event) => event.name === "daemon.connection.inbound_probe_sent");
    assert.equal(probe?.attrs?.cf_pop, "NRT57-P7");
    const timeout = traceEvents.find((event) => event.name === "daemon.connection.watchdog_timeout");
    assert.equal(timeout?.attrs?.cf_pop, "NRT57-P7");
    const disconnect = traceEvents.find((event) => event.name === "daemon.connection.disconnected");
    assert.equal(disconnect?.attrs?.close_code, 1006);
    assert.equal(disconnect?.attrs?.last_inbound_age_ms_bucket, "120s+");
    assert.equal(disconnect?.attrs?.cf_pop, "NRT57-P7");
    assert.ok(logs.some((line) => line.includes("Connected to server, cf_pop=NRT57-P7")));
    assert.ok(logs.some((line) => line.includes("Disconnected from server (code=1006") && line.includes("cf_pop=NRT57-P7")));

    // The replacement connection has no header (direct or local): null, not the old PoP.
    clock.advanceBy(1_000);
    assert.equal(getAllWs().length, 2);
    upgrade(getAllWs()[1], {});
    getAllWs()[1].emit("open");
    assert.equal(conn.cfPop, null);
    getAllWs()[1].serverClose(1006);
    const secondDisconnect = traceEvents.filter((event) => event.name === "daemon.connection.disconnected")[1];
    assert.equal(secondDisconnect?.attrs?.cf_pop, null);
    const lastDisconnectLog = logs.filter((line) => line.includes("Disconnected from server")).at(-1);
    assert.ok(lastDisconnectLog && !lastDisconnectLog.includes("cf_pop"), "no cf_pop in the log line without the header");

    const connectSpans = sink.getAllSpans().filter((span) => span.name === "daemon.connection.connect");
    assert.deepEqual(connectSpans.map((span) => span.attrs?.cf_pop), ["NRT57-P7", null]);

    // A header that is not a PoP code is not copied into traces.
    clock.advanceBy(2_000);
    upgrade(getAllWs()[2], { "x-amz-cf-pop": "NRT57 <script>" });
    getAllWs()[2].emit("open");
    assert.equal(conn.cfPop, "invalid_header");
  } finally {
    unsubscribe();
    conn.disconnect();
  }
});

test("message just before watchdog deadline extends the window deterministically", async () => {
  const clock = new FakeClock();
  const sockets: FakeWebSocket[] = [];

  const conn = new DaemonConnection({
    reconnectDelayFor: (backoffMs: number) => backoffMs,
    serverUrl: "http://localhost:9999",
    apiKey: "sk_machine_test",
    onMessage: () => {},
    onConnect: () => {},
    onDisconnect: () => {},
    inboundWatchdogMs: 70_000,
    minReconnectDelayMs: 1_000,
    clock,
    wsFactory: () => {
      const ws = new FakeWebSocket();
      sockets.push(ws);
      return ws as unknown as WebSocket;
    },
  });

  conn.connect();
  assert.equal(sockets.length, 1, "initial connect should create one socket");
  sockets[0].emit("open");

  clock.advanceBy(69_999);
  assert.equal(sockets[0].terminated, false, "watchdog should not fire before the first deadline");

  sockets[0].receiveMessage({ type: "ping" } as unknown as ServerToMachineMessage);
  clock.advanceBy(69_999);
  assert.equal(sockets[0].terminated, false, "inbound traffic should reset the watchdog window");

  clock.advanceBy(1);
  assert.equal(sockets[0].terminated, false, "watchdog should probe once the reset deadline fully elapses");
  assert.deepEqual(JSON.parse(sockets[0].sent.at(-1) ?? "{}"), { type: "ping" });

  clock.advanceBy(70_000);
  assert.equal(sockets[0].terminated, true, "watchdog should terminate if the probe is unanswered");

  conn.disconnect();
});

test("answered watchdog probe keeps an otherwise idle connection alive", async () => {
  const clock = new FakeClock();
  const sockets: FakeWebSocket[] = [];

  const conn = new DaemonConnection({
    reconnectDelayFor: (backoffMs: number) => backoffMs,
    serverUrl: "http://localhost:9999",
    apiKey: "sk_machine_test",
    onMessage: () => {},
    onConnect: () => {},
    onDisconnect: () => {},
    inboundWatchdogMs: 70_000,
    minReconnectDelayMs: 1_000,
    clock,
    wsFactory: () => {
      const ws = new FakeWebSocket();
      sockets.push(ws);
      return ws as unknown as WebSocket;
    },
  });

  conn.connect();
  sockets[0].emit("open");

  clock.advanceBy(70_000);
  assert.equal(sockets[0].terminated, false, "idle connection should be probed before reconnecting");
  assert.deepEqual(JSON.parse(sockets[0].sent.at(-1) ?? "{}"), { type: "ping" });

  sockets[0].receiveMessage({ type: "ping" } as unknown as ServerToMachineMessage);
  clock.advanceBy(69_999);
  assert.equal(sockets[0].terminated, false, "server echo should reset the watchdog window");

  clock.advanceBy(1);
  assert.equal(sockets[0].terminated, false, "next idle deadline should send a new probe, not churn");
  assert.deepEqual(JSON.parse(sockets[0].sent.at(-1) ?? "{}"), { type: "ping" });

  conn.disconnect();
});

test("outbound-only traffic does not mask an inbound black-hole", async () => {
  const clock = new FakeClock();
  const sockets: FakeWebSocket[] = [];

  const conn = new DaemonConnection({
    reconnectDelayFor: (backoffMs: number) => backoffMs,
    serverUrl: "http://localhost:9999",
    apiKey: "sk_machine_test",
    onMessage: () => {},
    onConnect: () => {},
    onDisconnect: () => {},
    inboundWatchdogMs: 70_000,
    minReconnectDelayMs: 1_000,
    clock,
    wsFactory: () => {
      const ws = new FakeWebSocket();
      sockets.push(ws);
      return ws as unknown as WebSocket;
    },
  });

  conn.connect();
  sockets[0].emit("open");

  clock.advanceBy(30_000);
  conn.send({ type: "pong" });
  clock.advanceBy(30_000);
  conn.send({ type: "pong" });
  clock.advanceBy(9_999);
  assert.equal(
    sockets[0].terminated,
    false,
    "outbound-only traffic should not terminate before the inbound watchdog threshold",
  );

  clock.advanceBy(1);
  assert.equal(
    sockets[0].terminated,
    false,
    "outbound-only traffic should trigger a liveness probe before reconnect",
  );
  assert.deepEqual(JSON.parse(sockets[0].sent.at(-1) ?? "{}"), { type: "ping" });

  clock.advanceBy(70_000);
  assert.equal(
    sockets[0].terminated,
    true,
    "unanswered outbound-only probe should not extend the inbound watchdog window",
  );

  conn.disconnect();
});

test("replacement socket can stabilize after a watchdog reconnect once inbound traffic resumes", async () => {
  const clock = new FakeClock();
  const sockets: FakeWebSocket[] = [];

  const conn = new DaemonConnection({
    reconnectDelayFor: (backoffMs: number) => backoffMs,
    serverUrl: "http://localhost:9999",
    apiKey: "sk_machine_test",
    onMessage: () => {},
    onConnect: () => {},
    onDisconnect: () => {},
    inboundWatchdogMs: 70_000,
    minReconnectDelayMs: 1_000,
    clock,
    wsFactory: () => {
      const ws = new FakeWebSocket();
      sockets.push(ws);
      return ws as unknown as WebSocket;
    },
  });

  conn.connect();
  sockets[0].emit("open");

  clock.advanceBy(70_000);
  assert.equal(sockets[0].terminated, false, "the original black-holed socket should be probed first");

  clock.advanceBy(70_000);
  assert.equal(sockets[0].terminated, true, "the original black-holed socket should be terminated after unanswered probe");

  clock.advanceBy(1_000);
  assert.equal(sockets.length, 2, "watchdog reconnect should create a replacement socket");
  sockets[1].emit("open");

  clock.advanceBy(69_999);
  sockets[1].receiveMessage({ type: "ping" } as unknown as ServerToMachineMessage);
  clock.advanceBy(69_999);
  assert.equal(
    sockets[1].terminated,
    false,
    "fresh inbound traffic on the replacement socket should stabilize the recovered connection",
  );

  conn.disconnect();
});

test("disconnect cancels a scheduled reconnect deterministically", async () => {
  const clock = new FakeClock();
  const sockets: FakeWebSocket[] = [];

  const conn = new DaemonConnection({
    reconnectDelayFor: (backoffMs: number) => backoffMs,
    serverUrl: "http://localhost:9999",
    apiKey: "sk_machine_test",
    onMessage: () => {},
    onConnect: () => {},
    onDisconnect: () => {},
    inboundWatchdogMs: 70_000,
    minReconnectDelayMs: 1_000,
    clock,
    wsFactory: () => {
      const ws = new FakeWebSocket();
      sockets.push(ws);
      return ws as unknown as WebSocket;
    },
  });

  conn.connect();
  sockets[0].emit("open");
  sockets[0].serverClose(1006);

  conn.disconnect();
  clock.advanceBy(5_000);
  assert.equal(sockets.length, 1, "disconnect should cancel any pending reconnect timer");
});

test("reconnect backoff doubles after consecutive failures and resets after a successful open", async () => {
  const clock = new FakeClock();
  const sockets: FakeWebSocket[] = [];

  const conn = new DaemonConnection({
    reconnectDelayFor: (backoffMs: number) => backoffMs,
    serverUrl: "http://localhost:9999",
    apiKey: "sk_machine_test",
    onMessage: () => {},
    onConnect: () => {},
    onDisconnect: () => {},
    inboundWatchdogMs: 70_000,
    minReconnectDelayMs: 1_000,
    clock,
    wsFactory: () => {
      const ws = new FakeWebSocket();
      sockets.push(ws);
      return ws as unknown as WebSocket;
    },
  });

  conn.connect();
  sockets[0].emit("open");
  sockets[0].serverClose(1006);

  clock.advanceBy(999);
  assert.equal(sockets.length, 1, "first reconnect should wait the minimum backoff");

  clock.advanceBy(1);
  assert.equal(sockets.length, 2, "first reconnect should happen after 1s");

  sockets[1].serverClose(1006);
  clock.advanceBy(1_999);
  assert.equal(sockets.length, 2, "second reconnect should wait the doubled backoff");

  clock.advanceBy(1);
  assert.equal(sockets.length, 3, "second reconnect should happen after 2s");

  sockets[2].emit("open");
  sockets[2].serverClose(1006);
  clock.advanceBy(999);
  assert.equal(sockets.length, 3, "a successful open should reset backoff to the minimum");

  clock.advanceBy(1);
  assert.equal(sockets.length, 4, "post-success reconnect should use the minimum delay again");

  conn.disconnect();
});

test("connect() is idempotent while already connecting, connected, or waiting to reconnect", async () => {
  const clock = new FakeClock();
  const sockets: FakeWebSocket[] = [];

  const conn = new DaemonConnection({
    reconnectDelayFor: (backoffMs: number) => backoffMs,
    serverUrl: "http://localhost:9999",
    apiKey: "sk_machine_test",
    onMessage: () => {},
    onConnect: () => {},
    onDisconnect: () => {},
    inboundWatchdogMs: 70_000,
    minReconnectDelayMs: 1_000,
    clock,
    wsFactory: () => {
      const ws = new FakeWebSocket();
      sockets.push(ws);
      return ws as unknown as WebSocket;
    },
  });

  conn.connect();
  conn.connect();
  assert.equal(sockets.length, 1, "calling connect twice should not create a duplicate socket");

  sockets[0].emit("open");
  conn.connect();
  assert.equal(sockets.length, 1, "calling connect while already open should be a no-op");

  sockets[0].serverClose(1006);
  conn.connect();
  assert.equal(sockets.length, 1, "calling connect while reconnect is already scheduled should not bypass the timer");

  clock.advanceBy(1_000);
  assert.equal(sockets.length, 2, "only the scheduled reconnect should create the next socket");

  conn.disconnect();
});

test("late close from a stale socket does not disturb the active replacement connection", async () => {
  const clock = new FakeClock();
  const sockets: FakeWebSocket[] = [];
  let disconnectCount = 0;

  const conn = new DaemonConnection({
    reconnectDelayFor: (backoffMs: number) => backoffMs,
    serverUrl: "http://localhost:9999",
    apiKey: "sk_machine_test",
    onMessage: () => {},
    onConnect: () => {},
    onDisconnect: () => { disconnectCount++; },
    inboundWatchdogMs: 70_000,
    minReconnectDelayMs: 1_000,
    clock,
    wsFactory: () => {
      const ws = new FakeWebSocket();
      sockets.push(ws);
      return ws as unknown as WebSocket;
    },
  });

  conn.connect();
  sockets[0].emit("open");
  sockets[0].serverClose(1006);
  assert.equal(disconnectCount, 1, "initial close should report one disconnect");

  clock.advanceBy(1_000);
  assert.equal(sockets.length, 2, "scheduled reconnect should create a replacement socket");
  sockets[1].emit("open");

  sockets[0].serverClose(1006);
  assert.equal(disconnectCount, 1, "stale close should not report another disconnect");

  clock.advanceBy(1_000);
  assert.equal(sockets.length, 2, "stale close should not schedule another reconnect");

  conn.disconnect();
});

test("late message from a stale socket does not reset the active socket watchdog", async () => {
  const clock = new FakeClock();
  const sockets: FakeWebSocket[] = [];

  const conn = new DaemonConnection({
    reconnectDelayFor: (backoffMs: number) => backoffMs,
    serverUrl: "http://localhost:9999",
    apiKey: "sk_machine_test",
    onMessage: () => {},
    onConnect: () => {},
    onDisconnect: () => {},
    inboundWatchdogMs: 70_000,
    minReconnectDelayMs: 1_000,
    clock,
    wsFactory: () => {
      const ws = new FakeWebSocket();
      sockets.push(ws);
      return ws as unknown as WebSocket;
    },
  });

  conn.connect();
  sockets[0].emit("open");
  sockets[0].serverClose(1006);

  clock.advanceBy(1_000);
  assert.equal(sockets.length, 2, "scheduled reconnect should create a replacement socket");
  sockets[1].emit("open");

  clock.advanceBy(69_999);
  sockets[0].receiveMessage({ type: "ping" } as unknown as ServerToMachineMessage);
  clock.advanceBy(1);
  assert.equal(sockets[1].terminated, false, "stale traffic should not prevent the active socket probe");
  assert.deepEqual(JSON.parse(sockets[1].sent.at(-1) ?? "{}"), { type: "ping" });

  clock.advanceBy(70_000);
  assert.equal(sockets[1].terminated, true, "stale traffic should not extend the active socket watchdog");

  conn.disconnect();
});

test("reconnect backoff caps at the maximum delay deterministically", async () => {
  const clock = new FakeClock();
  const sockets: FakeWebSocket[] = [];

  const conn = new DaemonConnection({
    reconnectDelayFor: (backoffMs: number) => backoffMs,
    serverUrl: "http://localhost:9999",
    apiKey: "sk_machine_test",
    onMessage: () => {},
    onConnect: () => {},
    onDisconnect: () => {},
    inboundWatchdogMs: 70_000,
    minReconnectDelayMs: 1_000,
    clock,
    wsFactory: () => {
      const ws = new FakeWebSocket();
      sockets.push(ws);
      return ws as unknown as WebSocket;
    },
  });

  conn.connect();
  sockets[0].serverClose(1006);

  clock.advanceBy(1_000);
  assert.equal(sockets.length, 2, "first reconnect should happen after 1s");
  sockets[1].serverClose(1006);

  clock.advanceBy(2_000);
  assert.equal(sockets.length, 3, "second reconnect should happen after 2s");
  sockets[2].serverClose(1006);

  clock.advanceBy(4_000);
  assert.equal(sockets.length, 4, "third reconnect should happen after 4s");
  sockets[3].serverClose(1006);

  clock.advanceBy(8_000);
  assert.equal(sockets.length, 5, "fourth reconnect should happen after 8s");
  sockets[4].serverClose(1006);

  clock.advanceBy(16_000);
  assert.equal(sockets.length, 6, "fifth reconnect should happen after 16s");
  sockets[5].serverClose(1006);

  clock.advanceBy(29_999);
  assert.equal(sockets.length, 6, "reconnect should still be waiting just before the capped 30s delay");

  clock.advanceBy(1);
  assert.equal(sockets.length, 7, "reconnect delay should cap at 30s");
  sockets[6].serverClose(1006);

  clock.advanceBy(29_999);
  assert.equal(sockets.length, 7, "subsequent retries should stay capped at 30s");

  clock.advanceBy(1);
  assert.equal(sockets.length, 8, "reconnect should continue using the capped delay");

  conn.disconnect();
});

test("receiving a message resets the watchdog — no spurious terminate within window", async () => {
  const { conn, getWs } = makeConnection({ inboundWatchdogMs: 80 });

  conn.connect();
  await waitForOpen();
  const ws = getWs();

  // Receive a message at ~40 ms (before original 80 ms watchdog fires)
  await new Promise((r) => setTimeout(r, 40));
  ws.receiveMessage({ type: "ping" } as unknown as ServerToMachineMessage);

  // At 40+50 = 90 ms from open, the NEW watchdog window has not yet elapsed
  // (it was reset to +80 ms from t=40, so it fires at t≈120).
  // At t=90 the connection should still be alive.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ws.terminated, false, "connection should still be alive after message resets watchdog");

  conn.disconnect();
});

test("close event clears watchdog — terminate() is not called on an already-closed socket", async () => {
  let terminalCalls = 0;
  const { conn, getWs } = makeConnection({ inboundWatchdogMs: 80 });

  conn.connect();
  await waitForOpen();
  const ws = getWs();

  const origTerminate = ws.terminate.bind(ws);
  ws.terminate = function (this: FakeWebSocket) {
    terminalCalls++;
    origTerminate.call(this);
  };

  // Server closes cleanly before the watchdog fires
  ws.serverClose(1000);

  // Wait past the original watchdog window
  await new Promise((r) => setTimeout(r, 110));
  assert.equal(terminalCalls, 0, "watchdog should not call terminate() after clean close");

  conn.disconnect();
});

test("disconnect() clears watchdog — no terminate() after disconnect", async () => {
  let terminalCalls = 0;
  const { conn, getWs } = makeConnection({ inboundWatchdogMs: 50 });

  conn.connect();
  await waitForOpen();
  const ws = getWs();

  // Patch terminate to count calls
  const origTerminate = ws.terminate.bind(ws);
  ws.terminate = function (this: FakeWebSocket) {
    terminalCalls++;
    origTerminate.call(this);
  };

  conn.disconnect();

  // Wait past watchdog window
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(terminalCalls, 0, "watchdog should not fire after disconnect()");
});

test("onConnect fires on every reconnect — agent:session can be reliably re-sent", async () => {
  // This covers the fix for issue #461 item 4:
  // An agent:session message dropped during a disconnect window is recovered
  // by re-sending it in the onConnect callback on every reconnect.
  const sentOnConnect: string[] = [];
  let connectCount = 0;

  const { conn, getWs } = makeConnection({
    onConnect: () => {
      connectCount++;
      // Simulate what index.ts does: re-send agent:session for all running agents
      conn.send({ type: "agent:session", agentId: "agent-1", sessionId: "sess-abc" } as any);
    },
    inboundWatchdogMs: 200,   // large — should not fire during test
    minReconnectDelayMs: 10,  // fast reconnect for test
  });

  // Track sent messages by capturing send() calls while WS is OPEN
  const origSend = (conn as any).options.onConnect;
  const sent: Array<{ type: string; connectRound: number }> = [];
  (conn as any).options.onConnect = () => {
    const round = connectCount + 1; // will be incremented by original onConnect
    origSend();
    // Record which round this send happened in
    sent.push({ type: "agent:session", connectRound: round });
  };

  conn.connect();
  await waitForOpen();
  assert.equal(connectCount, 1, "onConnect should fire on initial connect");

  // Simulate server closing (e.g. server restart / sleep/wake network drop)
  const ws1 = getWs();
  ws1.serverClose(1000);

  // Wait for reconnect (minReconnectDelayMs=10ms + open setImmediate)
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(connectCount, 2, "onConnect should fire again after reconnect");

  conn.disconnect();
});

test("replays a dropped exact session invalidation before reconnect session resync", async () => {
  let conn!: DaemonConnection;
  const fixture = makeConnection({
    onConnect: () => {
      conn.send({
        type: "agent:session",
        agentId: "agent-1",
        sessionId: "fresh-session",
        launchId: "launch-1",
      });
    },
  });
  conn = fixture.conn;

  conn.send({
    type: "agent:session:invalidate",
    agentId: "agent-1",
    sessionId: "stale-session",
    launchId: "launch-1",
    reason: "missing",
  });
  conn.connect();
  await waitForOpen();

  assert.deepEqual(fixture.getWs().sent.map((raw) => JSON.parse(raw)), [
    {
      type: "agent:session:invalidate",
      agentId: "agent-1",
      sessionId: "stale-session",
      launchId: "launch-1",
      reason: "missing",
    },
    {
      type: "agent:session",
      agentId: "agent-1",
      sessionId: "fresh-session",
      launchId: "launch-1",
    },
  ]);

  conn.disconnect();
});

test("does not replay an old-launch invalidation after a newer launch reuses the same session", async () => {
  let conn!: DaemonConnection;
  const fixture = makeConnection({
    onConnect: () => {
      conn.send({
        type: "agent:session",
        agentId: "agent-1",
        sessionId: "shared-session",
        launchId: "launch-new",
      });
    },
  });
  conn = fixture.conn;

  const staleInvalidation: MachineToServerMessage = {
    type: "agent:session:invalidate",
    agentId: "agent-1",
    sessionId: "shared-session",
    launchId: "launch-old",
    reason: "missing",
  };
  conn.send(staleInvalidation);
  conn.send({
    type: "agent:session",
    agentId: "agent-1",
    sessionId: "shared-session",
    launchId: "launch-new",
  });
  conn.send(staleInvalidation);

  conn.connect();
  await waitForOpen();

  assert.deepEqual(fixture.getWs().sent.map((raw) => JSON.parse(raw)), [{
    type: "agent:session",
    agentId: "agent-1",
    sessionId: "shared-session",
    launchId: "launch-new",
  }]);

  conn.disconnect();
});

test("replays each agent's latest status and activity only after ready, in client-sequence order (RFC 069 §8)", async () => {
  const { conn, getWs } = makeConnection({});

  conn.send({ type: "agent:status", agentId: "agent-1", status: "active", launchId: "launch-1", daemonInstanceId: "d-1", clientSeq: 1 });
  conn.send({ type: "agent:activity", agentId: "agent-1", activity: "working", detail: "Running", launchId: "launch-1", clientSeq: 2 });
  // The runtime exits while disconnected: this status is the one that must survive.
  conn.send({ type: "agent:status", agentId: "agent-1", status: "inactive", launchId: "launch-1", daemonInstanceId: "d-1", clientSeq: 3 });
  conn.send({ type: "agent:status", agentId: "agent-2", status: "active", launchId: "launch-2", daemonInstanceId: "d-1", clientSeq: 1 });

  conn.connect();
  await waitForOpen();
  // The server pins this connection's daemon instance id from `ready`; a
  // status that reached it first would be classified as unsequenced.
  conn.send({ type: "agent:status", agentId: "agent-2", status: "inactive", launchId: "launch-2", daemonInstanceId: "d-1", clientSeq: 2 });
  // Activity waits too: before `ready` the server lets it drive agent state.
  conn.send({ type: "agent:activity", agentId: "agent-3", activity: "working", detail: "Running", launchId: "launch-3", clientSeq: 1 });
  assert.deepEqual(getWs().sent, []);

  sendReady(conn);
  conn.send({ type: "agent:status", agentId: "agent-1", status: "active", launchId: "launch-1b", daemonInstanceId: "d-1", clientSeq: 4 });

  const sent = getWs().sent.map((payload) => JSON.parse(payload) as { type: string; agentId?: string; status?: string; clientSeq?: number });
  assert.deepEqual(
    sent.map((msg) => [msg.type, msg.agentId ?? null, msg.status ?? null, msg.clientSeq ?? null]),
    [
      ["ready", null, null, null],
      ["agent:activity", "agent-1", null, 2],
      ["agent:status", "agent-1", "inactive", 3],
      ["agent:activity", "agent-3", null, 1],
      ["agent:status", "agent-2", "inactive", 2],
      ["agent:status", "agent-1", "active", 4],
    ],
  );
});

type ReplayFrame = { type: string; agentId?: string; launchId?: string; status?: string; detailKind?: string };
const replayShape = (sent: string[]) => sent.map((payload) => JSON.parse(payload) as ReplayFrame)
  .map((msg) => [msg.type, msg.agentId ?? null, msg.launchId ?? null, msg.status ?? msg.detailKind ?? null]);

// A daemon-local restart and a per-turn continuation reuse the launch, so the
// server's failed-start streak depends on whether ready(L) or a failure of L
// came first: the replay must keep the order they were produced in.
test("replays a ready frame sent while disconnected in causal order with the agent's failure frames", async () => {
  const { conn, getWs } = makeConnection({});
  conn.send({ type: "agent:status", agentId: "agent-1", status: "active", launchId: "launch-1", daemonInstanceId: "d-1", clientSeq: 1 });
  conn.send({ type: "agent:runtime:ready", agentId: "agent-1", launchId: "launch-1" });
  conn.send({ type: "agent:status", agentId: "agent-1", status: "inactive", launchId: "launch-1", daemonInstanceId: "d-1", clientSeq: 2 });
  conn.send({ type: "agent:activity", agentId: "agent-1", activity: "offline", detail: "start failed", detailKind: "runtime_unavailable", launchId: "launch-1", clientSeq: 3 });
  // Coalesced: only the latest ready of an agent is kept.
  conn.send({ type: "agent:runtime:ready", agentId: "agent-2", launchId: "launch-2a" });
  conn.send({ type: "agent:runtime:ready", agentId: "agent-2", launchId: "launch-2b" });

  conn.connect();
  await waitForOpen();
  sendReady(conn);

  assert.deepEqual(replayShape(getWs().sent), [
    ["ready", null, null, null],
    ["agent:runtime:ready", "agent-1", "launch-1", null],
    ["agent:status", "agent-1", "launch-1", "inactive"],
    ["agent:activity", "agent-1", "launch-1", "runtime_unavailable"],
    ["agent:runtime:ready", "agent-2", "launch-2b", null],
  ]);
  conn.disconnect();
});

test("a failure followed by readiness while disconnected replays as failure, then ready", async () => {
  const { conn, getWs } = makeConnection({});
  conn.send({ type: "agent:status", agentId: "agent-1", status: "inactive", launchId: "launch-1", daemonInstanceId: "d-1", clientSeq: 1 });
  conn.send({ type: "agent:activity", agentId: "agent-1", activity: "offline", detail: "start failed", detailKind: "runtime_unavailable", launchId: "launch-1", clientSeq: 2 });
  conn.send({ type: "agent:status", agentId: "agent-1", status: "active", launchId: "launch-1", daemonInstanceId: "d-1", clientSeq: 3 });
  conn.send({ type: "agent:runtime:ready", agentId: "agent-1", launchId: "launch-1" });

  conn.connect();
  await waitForOpen();
  sendReady(conn);

  assert.deepEqual(replayShape(getWs().sent), [
    ["ready", null, null, null],
    ["agent:activity", "agent-1", "launch-1", "runtime_unavailable"],
    ["agent:status", "agent-1", "launch-1", "active"],
    ["agent:runtime:ready", "agent-1", "launch-1", null],
  ]);
  conn.disconnect();
});

test("a ready frame sent after the socket opens but before the daemon's ready is held in order with status and activity", async () => {
  const { conn, getWs } = makeConnection({});
  conn.connect();
  await waitForOpen();
  conn.send({ type: "agent:status", agentId: "agent-1", status: "active", launchId: "launch-1", daemonInstanceId: "d-1", clientSeq: 1 });
  conn.send({ type: "agent:runtime:ready", agentId: "agent-1", launchId: "launch-1" });
  conn.send({ type: "agent:status", agentId: "agent-1", status: "inactive", launchId: "launch-1", daemonInstanceId: "d-1", clientSeq: 2 });
  assert.deepEqual(getWs().sent, [], "nothing before the daemon's ready");

  sendReady(conn);
  assert.deepEqual(replayShape(getWs().sent), [
    ["ready", null, null, null],
    ["agent:runtime:ready", "agent-1", "launch-1", null],
    ["agent:status", "agent-1", "launch-1", "inactive"],
  ]);
  conn.disconnect();
});

// #proj-raft-computer:#48 (reconciler step 4b): the server lifts a wake block
// on `agent:credential:restored`, and the runtime error that set the block may
// itself be held or replayed: the restore is held and replayed with them, in
// the order produced, one per agent and reason.
test("a credential restore sent while disconnected replays after the error it ends and before a later one, one per agent and reason", async () => {
  const { conn, getWs } = makeConnection({});
  const restoredShape = (sent: string[]) => sent.map((payload) => JSON.parse(payload) as { type: string; agentId?: string; reason?: string; releaseCause?: string; detailKind?: string })
    .map((msg) => [msg.type, msg.agentId ?? null, msg.reason ?? msg.detailKind ?? null, msg.releaseCause ?? null]);
  conn.send({ type: "agent:activity", agentId: "agent-1", activity: "error", detail: "not logged in", detailKind: "runtime_error", launchId: "launch-1", clientSeq: 1 });
  conn.send({ type: "agent:credential:restored", agentId: "agent-1", reason: "user_reauth", releaseCause: "explicit_stop", launchId: "launch-1" });
  conn.send({ type: "agent:credential:restored", agentId: "agent-1", reason: "user_reauth", releaseCause: "model_output", launchId: "launch-1" });
  conn.send({ type: "agent:credential:restored", agentId: "agent-1", reason: "billing", releaseCause: "model_output", launchId: "launch-1" });
  conn.send({ type: "agent:credential:restored", agentId: "agent-2", reason: "user_model_access", releaseCause: "credentials_changed" });

  conn.connect();
  await waitForOpen();
  conn.send({ type: "agent:credential:restored", agentId: "agent-3", reason: "user_reauth", releaseCause: "credentials_changed" });
  assert.deepEqual(getWs().sent, [], "nothing before the daemon's ready");
  sendReady(conn);

  assert.deepEqual(restoredShape(getWs().sent), [
    ["ready", null, null, null],
    ["agent:activity", "agent-1", "runtime_error", null],
    ["agent:credential:restored", "agent-1", "user_reauth", "model_output"],
    ["agent:credential:restored", "agent-1", "billing", "model_output"],
    ["agent:credential:restored", "agent-2", "user_model_access", "credentials_changed"],
    ["agent:credential:restored", "agent-3", "user_reauth", "credentials_changed"],
  ]);

  // After ready it goes straight out.
  conn.send({ type: "agent:credential:restored", agentId: "agent-1", reason: "user_reauth", releaseCause: "explicit_stop" });
  assert.deepEqual(restoredShape(getWs().sent).at(-1), ["agent:credential:restored", "agent-1", "user_reauth", "explicit_stop"]);
  conn.disconnect();
});

test("holds status again on a new socket until that socket's ready (RFC 069 §8)", async () => {
  const { conn, getWs } = makeConnection({});

  conn.connect();
  await waitForOpen();
  sendReady(conn);
  conn.send({ type: "agent:status", agentId: "agent-1", status: "active", launchId: "launch-1", daemonInstanceId: "d-1", clientSeq: 1 });
  assert.deepEqual(getWs().sent.map((payload) => (JSON.parse(payload) as { type: string }).type), ["ready", "agent:status"]);

  conn.disconnect();
  conn.connect();
  await waitForOpen();
  conn.send({ type: "agent:status", agentId: "agent-1", status: "inactive", launchId: "launch-1", daemonInstanceId: "d-1", clientSeq: 2 });
  assert.deepEqual(getWs().sent, []);

  sendReady(conn);
  assert.deepEqual(
    getWs().sent.map((payload) => {
      const msg = JSON.parse(payload) as { type: string; status?: string };
      return [msg.type, msg.status ?? null];
    }),
    [["ready", null], ["agent:status", "inactive"]],
  );
  conn.disconnect();
});

test("replays latest dropped agent activity per agent after reconnect", async () => {
  const traceEvents: Array<{ name: string; attrs?: Record<string, unknown>; status?: TraceStatus }> = [];
  const { conn, getWs } = makeConnection({
    onTraceEvent: (name, attrs, status) => traceEvents.push({ name, attrs, status }),
  });

  conn.send({
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "Starting...",
    launchId: "launch-1",
    clientSeq: 1,
    producerFactId: "daemon_activity:agent-1:launch-1:1",
  });
  conn.send({
    type: "agent:activity",
    agentId: "agent-1",
    activity: "error",
    detail: "Startup timed out",
    launchId: "launch-1",
    clientSeq: 2,
    producerFactId: "daemon_activity:agent-1:launch-1:2",
  });
  conn.send({
    type: "agent:activity",
    agentId: "agent-2",
    activity: "offline",
    detail: "Stopped",
    launchId: "launch-2",
    clientSeq: 1,
    producerFactId: "daemon_activity:agent-2:launch-2:1",
  });

  conn.connect();
  await waitForOpen();
  sendReady(conn);

  const replayed = getWs().sent.slice(1).map((payload) => JSON.parse(payload) as { type: string; agentId?: string; activity?: string; detail?: string; launchId?: string; clientSeq?: number; producerFactId?: string });
  assert.deepEqual(replayed, [
    { type: "agent:activity", agentId: "agent-1", activity: "error", detail: "Startup timed out", launchId: "launch-1", clientSeq: 2, producerFactId: "daemon_activity:agent-1:launch-1:2" },
    { type: "agent:activity", agentId: "agent-2", activity: "offline", detail: "Stopped", launchId: "launch-2", clientSeq: 1, producerFactId: "daemon_activity:agent-2:launch-2:1" },
  ]);
  assert.equal(
    traceEvents.filter((event) => event.name === "daemon.connection.outbound_dropped").length,
    0,
    "a replayable activity frame is queued, not dropped",
  );
  const queuedTraces = traceEvents.filter((event) => event.name === "daemon.connection.outbound_queued");
  assert.equal(queuedTraces.length, 3, "each disconnected activity send is traced as queued");
  assert.deepEqual(
    queuedTraces.map((event) => [event.attrs?.agentId, event.attrs?.replaced_pending, event.attrs?.launch_id_present]),
    [["agent-1", false, true], ["agent-1", true, true], ["agent-2", false, true]],
    "the second agent-1 frame replaces the pending one (latest per agent kept)",
  );
  const replayTrace = traceEvents.find((event) => event.name === "daemon.connection.outbound_replayed");
  assert.equal(replayTrace?.attrs?.outbound_message_kind, "agent:activity");
  assert.equal(replayTrace?.attrs?.message_count, 2);
  const sentSpans = traceEvents.filter((event) => event.name === "daemon.agent.activity.sent");
  assert.equal(sentSpans.length, 2);
  assert.deepEqual(
    sentSpans.map((event) => ({
      agentId: event.attrs?.agent_id,
      launchId: event.attrs?.launch_id,
      clientSeq: event.attrs?.client_seq,
      sendPath: event.attrs?.send_path,
    })),
    [
      {
        agentId: "agent-1",
        launchId: "launch-1",
        clientSeq: 2,
        sendPath: "replay",
      },
      {
        agentId: "agent-2",
        launchId: "launch-2",
        clientSeq: 1,
        sendPath: "replay",
      },
    ],
  );

  conn.disconnect();
});

test("drops pending activity when disconnected lifecycle observes a new launch", async () => {
  const traceEvents: Array<{ name: string; attrs?: Record<string, unknown>; status?: TraceStatus }> = [];
  const { conn, getWs } = makeConnection({
    onTraceEvent: (name, attrs, status) => traceEvents.push({ name, attrs, status }),
  });

  conn.send({
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "old launch",
    launchId: "launch-x",
    clientSeq: 1,
  });
  conn.send({
    type: "agent:session",
    agentId: "agent-1",
    sessionId: "session-y",
    launchId: "launch-y",
  });

  conn.connect();
  await waitForOpen();

  assert.deepEqual(getWs().sent, [], "superseded old-launch activity should not replay on reconnect");
  assert.equal(
    traceEvents.filter((event) => event.name === "daemon.connection.outbound_queued").length,
    1,
    "the activity frame was queued at send time",
  );
  const dropped = traceEvents.filter((event) => event.name === "daemon.connection.outbound_dropped");
  assert.deepEqual(
    dropped.map((event) => [event.attrs?.outbound_message_kind, event.attrs?.reason]),
    [["agent:session", "not_replayable"]],
    "only the non-replayable session message is traced as dropped",
  );
  const invalidated = traceEvents.find((event) => event.name === "daemon.connection.pending_activity_invalidated");
  assert.equal(invalidated?.attrs?.reason, "launch_changed");
  assert.equal(invalidated?.attrs?.outbound_message_kind, "agent:session");
  assert.equal(invalidated?.attrs?.agentId, "agent-1");
  assert.equal(
    traceEvents.find((event) => event.name === "daemon.connection.outbound_replayed"),
    undefined,
    "nothing should be replayed after the old launch is invalidated",
  );

  conn.disconnect();
});

// task #1129: a queued activity frame must not be logged as "Dropping" — that
// wording sent an investigation after lost evidence that was in fact replayed.
test("disconnected activity send logs as queued for replay, not as dropped", async () => {
  const logs: string[] = [];
  const unsubscribe = subscribeDaemonLogs((event) => logs.push(event.message));
  try {
    const { conn } = makeConnection({});
    conn.send({ type: "agent:activity", agentId: "agent-1", activity: "working", detail: "x", launchId: "launch-1", clientSeq: 1 });
    conn.send({ type: "pong" });
    assert.ok(logs.some((line) => line.includes("Queued outbound agent:activity for replay while disconnected")), logs.join("\n"));
    assert.ok(!logs.some((line) => line.includes("Dropping outbound message while disconnected") && line.includes("agent:activity")), logs.join("\n"));
    assert.ok(logs.some((line) => line.includes("Dropping outbound message while disconnected (no replay path): pong")), logs.join("\n"));
    conn.disconnect();
  } finally {
    unsubscribe();
  }
});

// Task #374: the server closes the older of two connections using one machine
// key (reason duplicate_machine_connection) and refuses new ones while the
// winner is alive (reason duplicate_machine_connection_held).
async function reconnectDelayAfterCloses(closes: Array<[number, string]>): Promise<{
  delays: unknown[];
  duplicateEvents: Array<Record<string, unknown> | undefined>;
}> {
  const traceEvents: Array<{ name: string; attrs?: Record<string, unknown> }> = [];
  const clock = new FakeClock();
  const { conn, getWs } = makeConnection({
    onTraceEvent: (name, attrs) => traceEvents.push({ name, attrs }),
    minReconnectDelayMs: 1000,
    clock,
    autoOpen: false,
  });
  conn.connect();
  for (const [code, reason] of closes) {
    getWs().emit("open");
    getWs().close(code, reason);
    const scheduled = traceEvents.filter((event) => event.name === "daemon.connection.reconnect_scheduled").at(-1);
    // Let the scheduled reconnect fire, which opens the next socket.
    clock.advanceBy(Number(scheduled?.attrs?.delay_ms ?? 0));
  }
  conn.disconnect();
  return {
    delays: traceEvents.filter((event) => event.name === "daemon.connection.reconnect_scheduled").map((event) => event.attrs?.delay_ms),
    duplicateEvents: traceEvents.filter((event) => event.name === "daemon.connection.duplicate_machine_close").map((event) => event.attrs),
  };
}

test("task #374: closed as the duplicate, the daemon waits five minutes before reconnecting", async () => {
  const { delays, duplicateEvents } = await reconnectDelayAfterCloses([[4003, "duplicate_machine_connection"]]);
  assert.deepEqual(delays, [DaemonConnection.DUPLICATE_RECONNECT_DELAY_MS]);
  assert.deepEqual(duplicateEvents, [{ close_reason: "closed_as_duplicate", long_delay: true }]);
});

test("task #374: refused while another process holds the key, a winner whose own socket dropped keeps the normal backoff", async () => {
  const { delays, duplicateEvents } = await reconnectDelayAfterCloses([[4003, "duplicate_machine_connection_held"]]);
  assert.deepEqual(delays, [1000], "back within the server's hold window, not five minutes later");
  assert.deepEqual(duplicateEvents, [{ close_reason: "refused_held", long_delay: false }]);
});

test("task #374: after being closed as the duplicate, later refusals keep the long delay instead of retrying every few seconds", async () => {
  const { delays } = await reconnectDelayAfterCloses([
    [4003, "duplicate_machine_connection"],
    [4003, "duplicate_machine_connection_held"],
    [4003, "duplicate_machine_connection_held"],
  ]);
  assert.deepEqual(delays, [
    DaemonConnection.DUPLICATE_RECONNECT_DELAY_MS,
    DaemonConnection.DUPLICATE_RECONNECT_DELAY_MS,
    DaemonConnection.DUPLICATE_RECONNECT_DELAY_MS,
  ]);
});

// A server that refuses a held duplicate during the handshake answers 409
// (Slock-Reason duplicate_machine_connection_held); the socket never opens and
// the daemon terminates it (close 1006). Steps are either an opened socket the
// server closes, or a rejected handshake.
type DuplicateStep = { close: [number, string] } | { reject: [number, string] };

async function reconnectDelayAfterSteps(steps: DuplicateStep[]): Promise<{
  delays: unknown[];
  duplicateEvents: Array<Record<string, unknown> | undefined>;
}> {
  const traceEvents: Array<{ name: string; attrs?: Record<string, unknown> }> = [];
  const clock = new FakeClock();
  const { conn, getWs } = makeConnection({
    onTraceEvent: (name, attrs) => traceEvents.push({ name, attrs }),
    minReconnectDelayMs: 1000,
    clock,
    autoOpen: false,
  });
  conn.connect();
  for (const step of steps) {
    const ws = getWs();
    if ("close" in step) {
      ws.emit("open");
      ws.close(step.close[0], step.close[1]);
    } else {
      ws.emit("unexpected-response", {}, {
        statusCode: step.reject[0],
        headers: { "slock-reason": step.reject[1] },
        resume() {},
      });
    }
    const scheduled = traceEvents.filter((event) => event.name === "daemon.connection.reconnect_scheduled").at(-1);
    clock.advanceBy(Number(scheduled?.attrs?.delay_ms ?? 0));
  }
  conn.disconnect();
  return {
    delays: traceEvents.filter((event) => event.name === "daemon.connection.reconnect_scheduled").map((event) => event.attrs?.delay_ms),
    duplicateEvents: traceEvents.filter((event) => event.name === "daemon.connection.duplicate_machine_close").map((event) => event.attrs),
  };
}

test("task #374: a 409 held-duplicate handshake refusal keeps the five-minute delay after being closed as the duplicate", async () => {
  const { delays, duplicateEvents } = await reconnectDelayAfterSteps([
    { close: [4003, "duplicate_machine_connection"] },
    { reject: [409, "duplicate_machine_connection_held"] },
    { reject: [409, "duplicate_machine_connection_held"] },
  ]);
  assert.deepEqual(delays, [
    DaemonConnection.DUPLICATE_RECONNECT_DELAY_MS,
    DaemonConnection.DUPLICATE_RECONNECT_DELAY_MS,
    DaemonConnection.DUPLICATE_RECONNECT_DELAY_MS,
  ]);
  assert.deepEqual(duplicateEvents.map((event) => event?.close_reason), ["closed_as_duplicate", "refused_held", "refused_held"]);
});

test("task #374: a 409 held refusal without a recent duplicate close keeps the normal backoff (a winner whose socket dropped)", async () => {
  const { delays, duplicateEvents } = await reconnectDelayAfterSteps([{ reject: [409, "duplicate_machine_connection_held"] }]);
  assert.deepEqual(delays, [1000]);
  assert.deepEqual(duplicateEvents, [{ close_reason: "refused_held", long_delay: false }]);
});

test("task #374: other handshake rejections are not treated as duplicate refusals", async () => {
  const { delays, duplicateEvents } = await reconnectDelayAfterSteps([
    { close: [4003, "duplicate_machine_connection"] },
    { reject: [409, "something_else"] },
  ]);
  assert.equal(delays.length, 2);
  assert.notEqual(delays[1], DaemonConnection.DUPLICATE_RECONNECT_DELAY_MS, "an unrelated 409 keeps the normal backoff");
  assert.deepEqual(duplicateEvents.map((event) => event?.close_reason), ["closed_as_duplicate"]);
});

test("task #374: other server close codes keep the normal backoff", async () => {
  const { delays, duplicateEvents } = await reconnectDelayAfterCloses([[4001, "computer_machine_unlinked"]]);
  assert.deepEqual(delays, [1000]);
  assert.deepEqual(duplicateEvents, []);
});
