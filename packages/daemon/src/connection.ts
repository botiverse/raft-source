import type { ClientRequest, IncomingMessage } from "node:http";
import WebSocket from "ws";
import {
  clearClockTimeout,
  currentTimeMs,
  errorClassOf,
  MACHINE_DUPLICATE_CONNECTION_CLOSE_CODE,
  MACHINE_DUPLICATE_CONNECTION_CLOSE_REASON,
  MACHINE_DUPLICATE_CONNECTION_HELD_CLOSE_REASON,
  noopTracer,
  setClockTimeout,
  type ActiveSpan,
  type ServerToMachineMessage,
  type MachineToServerMessage,
  type TraceContext,
  type TraceStatus,
  type Tracer,
  RAFT_SERVER_CAPABILITIES_HEADER,
} from "@botiverse/raft-shared";
import { logger } from "./logger";
import { buildWebSocketOptions } from "./proxy";

type WebSocketOptions = import("ws").ClientOptions;
type AgentActivityMessage = Extract<MachineToServerMessage, { type: "agent:activity" }>;

export type DaemonConnectionControlPlaneTraceEvent =
  | "daemon.connection.disconnected"
  | "daemon.connection.reconnect_scheduled"
  | "daemon.connection.connected";

export interface DaemonConnectionTraceClassification {
  kind: "control_plane";
  eventClass: "control_plane_reconnect";
  traceEvent: DaemonConnectionControlPlaneTraceEvent;
  shouldAffectRuntimeState: false;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: "open", listener: () => void): unknown;
  on(event: "message", listener: (data: Buffer) => void): unknown;
  on(event: "close", listener: (code: number, reasonBuffer: Buffer) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "unexpected-response", listener: (request: ClientRequest, response: IncomingMessage) => void): unknown;
  /** task #1268: the 101 response, emitted by `ws` before `open`; carries `RAFT_SERVER_CAPABILITIES_HEADER`. */
  on(event: "upgrade", listener: (response: IncomingMessage) => void): unknown;
}

/** task #1268: parse the space/comma-separated capability header value(s); unknown shapes yield []. */
export function parseServerCapabilitiesHeader(value: string | string[] | undefined): string[] {
  const raw = Array.isArray(value) ? value.join(" ") : value ?? "";
  return [...new Set(raw.split(/[\s,]+/).map((token) => token.trim()).filter(Boolean))];
}

export const systemClock: Clock = {
  now: currentTimeMs,
  setTimeout: setClockTimeout,
  clearTimeout: clearClockTimeout,
};

export interface ConnectionOptions {
  serverUrl: string;
  apiKey: string;
  onMessage: (msg: ServerToMachineMessage) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onHandshakeRejected?: (event: { statusCode: number; reason: string | null }) => void;
  onTraceEvent?: (name: string, attrs?: Record<string, unknown>, status?: TraceStatus, parent?: TraceContext | null) => void;
  /** Records the connect attempt span and the inbound message span. Default: noop. */
  tracer?: Tracer;
  /** Override inbound watchdog timeout for testing. Default: 70_000 ms. */
  inboundWatchdogMs?: number;
  /** Override WebSocket connect-attempt timeout for testing. Default: 30_000 ms. */
  connectTimeoutMs?: number;
  /** Override minimum reconnect delay for testing. Default: 1_000 ms. */
  minReconnectDelayMs?: number;
  /** Override WebSocket constructor for testing. Default: ws.WebSocket. */
  wsFactory?: (url: string, options?: WebSocketOptions) => WebSocketLike;
  /** Override proxy env resolution for testing. Default: process.env. */
  proxyEnv?: NodeJS.ProcessEnv;
  /** Override clock / timer primitives for deterministic tests. */
  clock?: Clock;
  /**
   * Maps the current backoff to the actual reconnect delay. Default: full
   * jitter over max(backoff, RECONNECT_SPREAD_MS). Tests pin it to the backoff.
   */
  reconnectDelayFor?: (backoffMs: number) => number;
}

// A deploy stops a server task and drops every daemon connected to it at the
// same instant. Without jitter they all come back on the same schedule
// (1s, 2s, 4s…), and their reconnect work lands on the shared database pooler
// together: 2026-09-26 ~04:59Z, ~30s fleet-wide stall right after a release.
// Full jitter spreads each reconnect uniformly over the window; the first window
// is at least RECONNECT_SPREAD_MS so a mass disconnect is spread over seconds.
const RECONNECT_SPREAD_MS = 5_000;

function jitteredReconnectDelay(backoffMs: number): number {
  return Math.floor(Math.random() * Math.max(backoffMs, RECONNECT_SPREAD_MS));
}

// The server sends a ping every 30 s. If the daemon receives nothing for
// INBOUND_WATCHDOG_MS it sends an application-level probe before forcing a
// TCP-level reset. Healthy idle links can answer the probe instead of churning.
const INBOUND_WATCHDOG_MS = 70_000;
const CONNECT_TIMEOUT_MS = 30_000;
const LEGACY_MACHINE_KEY_MIGRATED_REASON = "legacy_machine_key_migrated";

function isTerminalMigratedKeyRejection(statusCode: number, reason: string | null): boolean {
  return statusCode === 401 && reason === LEGACY_MACHINE_KEY_MIGRATED_REASON;
}

function normalizeHandshakeReason(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!/^[a-z0-9_:-]{1,80}$/i.test(trimmed)) return "invalid_header";
  return trimmed;
}

// CloudFront names the edge location (PoP) that served a request, e.g.
// `NRT57-P7`. Fleet-wide 1006 waves are suspected to follow particular PoPs,
// so connect and disconnect traces carry it. Absent (direct or local
// connection) -> null; anything that is not a short PoP code -> invalid_header.
const CLOUDFRONT_POP_HEADER = "x-amz-cf-pop";

function normalizeCfPopHeader(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!/^[a-z0-9-]{1,32}$/i.test(trimmed)) return "invalid_header";
  return trimmed;
}

function durationMsBucket(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "unknown";
  if (ms === 0) return "0";
  if (ms <= 1_000) return "1s";
  if (ms <= 10_000) return "1s-10s";
  if (ms <= 30_000) return "10s-30s";
  if (ms <= 60_000) return "30s-60s";
  if (ms <= 120_000) return "60s-120s";
  return "120s+";
}

export function classifyDaemonConnectionTraceEvent(
  name: string,
  attrs: Record<string, unknown> | undefined,
): DaemonConnectionTraceClassification | null {
  if (name === "daemon.connection.reconnect_scheduled") {
    return {
      kind: "control_plane",
      eventClass: "control_plane_reconnect",
      traceEvent: name,
      shouldAffectRuntimeState: false,
    };
  }

  if (name === "daemon.connection.disconnected" && attrs?.reconnecting === true) {
    return {
      kind: "control_plane",
      eventClass: "control_plane_reconnect",
      traceEvent: name,
      shouldAffectRuntimeState: false,
    };
  }

  if (
    name === "daemon.connection.connected" &&
    typeof attrs?.reconnect_attempt === "number" &&
    attrs.reconnect_attempt > 0
  ) {
    return {
      kind: "control_plane",
      eventClass: "control_plane_reconnect",
      traceEvent: name,
      shouldAffectRuntimeState: false,
    };
  }

  return null;
}

/** One held `agent:credential:restored` per agent and reason. */
function credentialRestoredKey(msg: Extract<MachineToServerMessage, { type: "agent:credential:restored" }>): string {
  return `${msg.agentId}\u0000${msg.reason}`;
}

type OutboundDisposition =
  | { kind: "queued"; agentId: string; launchIdPresent: boolean; replacedPending: boolean }
  | { kind: "superseded" }
  | { kind: "not_replayable" };

export class DaemonConnection {
  /** task #1268: server capabilities read from the current connection's 101 response header. */
  private handshakeServerCapabilitiesValue: string[] = [];
  get handshakeServerCapabilities(): readonly string[] {
    return this.handshakeServerCapabilitiesValue;
  }
  /** CloudFront PoP from the current connection's handshake response; null when absent. */
  private cfPopValue: string | null = null;
  get cfPop(): string | null {
    return this.cfPopValue;
  }
  private ws: WebSocketLike | null = null;
  private options: ConnectionOptions;
  private readonly clock: Clock;
  private readonly tracer: Tracer;
  private reconnectTimer: unknown = null;
  private watchdogTimer: unknown = null;
  private connectTimeoutTimer: unknown = null;
  private reconnectDelay: number;
  private readonly maxReconnectDelay = 30000;
  /**
   * Task #374: the server closed this connection as the older of two that use
   * the same machine key. Reconnecting every few seconds would only be refused
   * again (or, against an older server, kick the other process off), so wait
   * this long instead; never stop reconnecting, the other process may exit.
   */
  static readonly DUPLICATE_RECONNECT_DELAY_MS = 5 * 60_000;
  /** How long a duplicate close keeps "refused while the other holds the key" on the long delay. */
  static readonly DUPLICATE_MEMORY_MS = 30 * 60_000;
  private duplicateClosedAt: number | null = null;
  private nextReconnectDelayOverrideMs: number | null = null;
  private shouldConnect = true;
  private reconnectAttempt = 0;
  private connectAttempt: ConnectAttemptSpan | null = null;
  private lastDroppedSendLogAt = 0;
  private lastQueuedSendLogAt = 0;
  private lastInboundAt: number | null = null;
  private lastInboundMessageKind: string | null = null;
  private inboundProbeInFlight = false;
  private readonly pendingActivityByAgent = new Map<string, AgentActivityMessage>();
  private readonly pendingSessionInvalidationByAgent = new Map<
    string,
    Extract<MachineToServerMessage, { type: "agent:session:invalidate" }>
  >();
  /**
   * RFC 069 §8: the latest status per agent is replayed after a reconnect, so
   * the server's view of whether a runtime exists never depends on activity.
   */
  private readonly pendingStatusByAgent = new Map<string, Extract<MachineToServerMessage, { type: "agent:status" }>>();
  /**
   * The latest `agent:runtime:ready` per agent (newest launch wins), held
   * and replayed like status: the server ends a failed-start streak only on
   * it, and the failures it would end are themselves replayed.
   */
  private readonly pendingRuntimeReadyByAgent = new Map<string, Extract<MachineToServerMessage, { type: "agent:runtime:ready" }>>();
  /**
   * Reconciler step 4b: `agent:credential:restored` per agent and reason
   * (latest kept), held and replayed in order with that agent's status and
   * activity: the server lifts a wake block on it, and the runtime error that
   * set the block may itself be held or replayed.
   */
  private readonly pendingCredentialRestored = new Map<string, Extract<MachineToServerMessage, { type: "agent:credential:restored" }>>();
  /**
   * When each held frame was queued. A readiness frame has no client
   * sequence, and a daemon-local restart or a per-turn continuation reuses
   * the launch, so ready(L) and a failure of L can come in either order; the
   * replay keeps the order they were produced.
   */
  private readonly enqueueOrder = new WeakMap<MachineToServerMessage, number>();
  private nextEnqueueOrder = 0;
  /**
   * RFC 069 §8: the socket this daemon has sent `ready` on. The server learns
   * the connection's daemon instance id and capabilities from `ready`; before
   * that it takes a status frame as unsequenced and lets activity drive agent
   * state (legacy). So status and activity are held (latest per agent) until
   * `ready` has gone out on the current socket.
   */
  private readySentOn: WebSocketLike | null = null;
  private readonly latestObservedLaunchIdByAgent = new Map<string, string>();

  constructor(options: ConnectionOptions) {
    this.options = options;
    this.clock = options.clock ?? systemClock;
    this.tracer = options.tracer ?? noopTracer;
    this.reconnectDelay = options.minReconnectDelayMs ?? 1000;
  }

  connect() {
    this.shouldConnect = true;
    if (this.reconnectTimer) return;
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) return;
    this.doConnect();
  }

  disconnect() {
    this.shouldConnect = false;
    this.pendingActivityByAgent.clear();
    this.pendingStatusByAgent.clear();
    this.pendingRuntimeReadyByAgent.clear();
    this.pendingCredentialRestored.clear();
    this.pendingSessionInvalidationByAgent.clear();
    this.clearWatchdog();
    this.clearConnectTimeout();
    if (this.reconnectTimer) {
      this.clock.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // The socket handlers ignore events once `this.ws` is cleared, so end a
    // pending connect attempt here.
    this.connectAttempt?.end("cancelled", { outcome: "disconnect_requested" });
    this.connectAttempt = null;
    if (this.ws) {
      logger.info("[Daemon] Disconnect requested");
      this.ws.close();
      this.ws = null;
    }
  }

  send(msg: MachineToServerMessage) {
    if (
      this.ws?.readyState === WebSocket.OPEN
      && (msg.type === "agent:status" || msg.type === "agent:activity" || msg.type === "agent:runtime:ready" || msg.type === "agent:credential:restored")
      && this.readySentOn !== this.ws
    ) {
      this.observeLaunchIdentity(msg);
      const disposition = this.queueReplayableMessage(msg);
      this.trace(disposition.kind === "queued" ? "daemon.connection.outbound_queued" : "daemon.connection.outbound_dropped", {
        outbound_message_kind: msg.type,
        ...(disposition.kind === "queued"
          ? {
              agentId: disposition.agentId,
              launch_id_present: disposition.launchIdPresent,
              replaced_pending: disposition.replacedPending,
            }
          : { reason: "superseded_launch" }),
        ws_ready_state: this.ws.readyState,
        held_until_ready: true,
      });
      return;
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.observeLaunchIdentity(msg);
      if (msg.type === "agent:activity") {
        this.pendingActivityByAgent.delete(msg.agentId);
      }
      if (msg.type === "agent:status") {
        this.pendingStatusByAgent.delete(msg.agentId);
      }
      if (msg.type === "agent:runtime:ready") {
        this.pendingRuntimeReadyByAgent.delete(msg.agentId);
      }
      if (msg.type === "agent:credential:restored") {
        this.pendingCredentialRestored.delete(credentialRestoredKey(msg));
      }
      if (msg.type === "agent:session:invalidate") {
        this.pendingSessionInvalidationByAgent.delete(msg.agentId);
      }
      this.ws.send(JSON.stringify(msg));
      this.traceActivitySent(msg, "websocket_open");
      if (msg.type === "ready") {
        this.readySentOn = this.ws;
        this.flushPendingActivity(this.ws);
      }
      return;
    }

    this.observeLaunchIdentity(msg);
    const disposition = this.queueReplayableMessage(msg);
    const now = this.clock.now();

    // Three outcomes, three names (task #1129 observability): a replayable
    // message (agent:activity, agent:session:invalidate) is QUEUED — the
    // latest per agent is kept and replayed on reconnect — a replayable one
    // for a superseded launch is dropped as stale, and anything else is
    // dropped because it has no replay path. The old single "Dropping
    // outbound" line made a queued activity frame read as lost evidence.
    if (disposition.kind === "queued") {
      if (now - this.lastQueuedSendLogAt > 5000) {
        this.lastQueuedSendLogAt = now;
        logger.info(`[Daemon] Queued outbound ${msg.type} for replay while disconnected (latest per agent kept)`);
      }
      this.trace("daemon.connection.outbound_queued", {
        outbound_message_kind: msg.type,
        agentId: disposition.agentId,
        launch_id_present: disposition.launchIdPresent,
        replaced_pending: disposition.replacedPending,
        ws_ready_state: this.ws?.readyState ?? null,
      });
      return;
    }
    if (disposition.kind === "not_replayable" && now - this.lastDroppedSendLogAt > 5000) {
      this.lastDroppedSendLogAt = now;
      logger.warn(`[Daemon] Dropping outbound message while disconnected (no replay path): ${msg.type}`);
    }
    this.trace("daemon.connection.outbound_dropped", {
      outbound_message_kind: msg.type,
      reason: disposition.kind === "superseded" ? "superseded_launch" : "not_replayable",
      ws_ready_state: this.ws?.readyState ?? null,
    });
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private doConnect() {
    if (!this.shouldConnect) return;
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) return;

    const wsUrl = this.options.serverUrl.replace(/^http/, "ws") + "/daemon/connect";
    const wsOptions = {
      ...buildWebSocketOptions(wsUrl, this.options.proxyEnv ?? process.env),
      headers: { Authorization: `Bearer ${this.options.apiKey}` },
    };

    logger.info(`[Daemon] Connecting to ${this.options.serverUrl}...`);
    if (wsOptions?.agent) {
      logger.info("[Daemon] Using configured proxy for WebSocket connection");
    }
    const connectStartedAt = this.clock.now();
    const connectAttempt = new ConnectAttemptSpan(this.tracer.startSpan("daemon.connection.connect", {
      surface: "daemon",
      kind: "client",
      startTimeMs: connectStartedAt,
      attrs: {
        reconnect_attempt: this.reconnectAttempt,
        server_url_present: Boolean(this.options.serverUrl),
        proxy_present: Boolean(wsOptions?.agent),
      },
    }));
    this.connectAttempt = connectAttempt;

    const ws: WebSocketLike = this.options.wsFactory ? this.options.wsFactory(wsUrl, wsOptions) : new WebSocket(wsUrl, wsOptions);
    this.ws = ws;
    // task #1268: capabilities are per connection; a previous connection's header
    // must never describe this one.
    this.handshakeServerCapabilitiesValue = [];
    this.cfPopValue = null;
    let handshakeRejected = false;
    ws.on("upgrade", (response) => {
      if (this.ws !== ws) return;
      this.handshakeServerCapabilitiesValue = parseServerCapabilitiesHeader(response.headers[RAFT_SERVER_CAPABILITIES_HEADER]);
      this.cfPopValue = normalizeCfPopHeader(response.headers[CLOUDFRONT_POP_HEADER]);
    });
    this.armConnectTimeout(ws, connectStartedAt, connectAttempt);

    ws.on("open", () => {
      if (this.ws !== ws) return;
      if (!this.shouldConnect) {
        // disconnect() was called before open fired
        connectAttempt.end("cancelled", { outcome: "disconnect_requested" });
        return;
      }
      this.clearConnectTimeout();
      logger.info(`[Daemon] Connected to server${this.cfPopLogField()}`);
      this.reconnectAttempt = 0;
      // Reset backoff
      this.reconnectDelay = this.options.minReconnectDelayMs ?? 1000;
      this.markInbound("websocket_open");
      this.resetWatchdog();
      connectAttempt.end("ok", {
        outcome: "connected",
        cf_pop: this.cfPopValue,
        inbound_watchdog_ms: this.options.inboundWatchdogMs ?? INBOUND_WATCHDOG_MS,
      });
      this.flushPendingSessionInvalidations(ws);
      // Pending status/activity replay waits for `ready` (see readySentOn).
      this.options.onConnect();
    });

    ws.on("message", (data: Buffer) => {
      if (this.ws !== ws) return;
      let msg: ServerToMachineMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch (err) {
        this.markInbound("invalid_json");
        this.resetWatchdog();
        logger.error("[Daemon] Invalid message from server", err);
        this.trace("daemon.connection.invalid_message", {
          error_class: errorClassOf(err),
          last_inbound_message_kind: "invalid_json",
        }, "error");
        return;
      }
      this.markInbound(msg.type);
      this.resetWatchdog();
      if (msg.type === "ping") {
        this.dispatchInbound(msg);
        return;
      }
      // The span covers only the synchronous handler call. It is not made
      // active, so async work started by the handler does not attach to it.
      const span = this.tracer.startSpan("daemon.connection.inbound", {
        surface: "daemon",
        kind: "consumer",
        attrs: { inbound_message_kind: msg.type },
      });
      const errorClass = this.dispatchInbound(msg);
      if (errorClass) {
        span.end("error", { attrs: { error_class: errorClass } });
      } else {
        span.end("ok");
      }
    });

    ws.on("close", (code, reasonBuffer) => {
      if (this.ws !== ws) return;
      connectAttempt.end("cancelled", { outcome: "closed", close_code: code });
      this.ws = null;
      this.clearConnectTimeout();
      this.clearWatchdog();
      const reason = reasonBuffer.toString("utf8");
      logger.warn(
        `[Daemon] Disconnected from server (code=${code}, reason=${JSON.stringify(reason)}, reconnecting=${this.shouldConnect}${this.cfPopLogField()})`,
      );
      this.trace("daemon.connection.disconnected", {
        close_code: code,
        close_reason_present: Boolean(reason),
        reconnecting: this.shouldConnect,
        reconnect_attempt: this.reconnectAttempt,
        last_inbound_message_kind: this.lastInboundMessageKind,
        last_inbound_age_ms_bucket: this.lastInboundAgeBucket(),
        cf_pop: this.cfPopValue,
      }, this.shouldConnect ? "cancelled" : "ok");
      if (code === MACHINE_DUPLICATE_CONNECTION_CLOSE_CODE) this.noteDuplicateMachineClose(reason);
      this.options.onDisconnect();
      this.scheduleReconnect();
    });

    ws.on("unexpected-response", (_request, response) => {
      if (this.ws !== ws) return;
      this.clearConnectTimeout();
      handshakeRejected = true;
      const reason = normalizeHandshakeReason(response.headers["slock-reason"]);
      const statusCode = response.statusCode ?? 0;
      const reasonText = reason ? `, slock_reason=${reason}` : "";
      this.cfPopValue = normalizeCfPopHeader(response.headers[CLOUDFRONT_POP_HEADER]);
      logger.error(`[Daemon] WebSocket handshake rejected (status=${statusCode}${reasonText}${this.cfPopLogField()})`);
      this.trace("daemon.connection.handshake_rejected", {
        status_code: statusCode,
        slock_reason_present: Boolean(reason),
        slock_reason: reason,
        cf_pop: this.cfPopValue,
      }, "error", connectAttempt.context);
      connectAttempt.end("error", { outcome: "handshake_rejected", status_code: statusCode });
      if (isTerminalMigratedKeyRejection(statusCode, reason)) {
        // The server has permanently retired this legacy key. Retrying cannot
        // recover, and a stale/copy host may not have local Computer state for
        // the startup migration guard to recognize. Stop the connection loop
        // here and point the user to the server-aware install/setup commands.
        this.shouldConnect = false;
        logger.error(
          "[Daemon] This legacy machine key was already migrated to Raft Computer. " +
            "Reconnects are stopped because this key cannot authenticate again.\n" +
            "Stop and disable this legacy raft-daemon process. In Raft, open this offline Computer and choose " +
            '"raft-computer: command not found? Install or re-run setup" to copy the install and setup commands for this server.',
        );
        this.trace("daemon.connection.reconnect_stopped", {
          status_code: statusCode,
          slock_reason: reason,
          terminal: true,
        }, "error");
      }
      // Task #374: a server that refuses a held duplicate during the handshake
      // answers 409 instead of opening and closing with 4003; it gets the same
      // duplicate handling, so a recently displaced loser keeps its long delay.
      if (statusCode === 409 && reason !== null && reason === MACHINE_DUPLICATE_CONNECTION_HELD_CLOSE_REASON) {
        this.noteDuplicateMachineClose(reason);
      }
      this.options.onHandshakeRejected?.({ statusCode, reason });
      response.resume();
      try { ws.terminate(); } catch { /* ignore */ }
    });

    ws.on("error", (err) => {
      if (this.ws !== ws) return;
      if (handshakeRejected) return;
      logger.error(`[Daemon] WebSocket error: ${err.message}`);
      this.trace("daemon.connection.error", {
        error_class: err.name || "Error",
        cf_pop: this.cfPopValue,
      }, "error", connectAttempt.isOpen ? connectAttempt.context : null);
      connectAttempt.end("error", { outcome: "error", error_class: err.name || "Error" });
      // 'close' will fire after this
    });
  }

  private dispatchInbound(msg: ServerToMachineMessage): string | null {
    try {
      this.options.onMessage(msg);
      return null;
    } catch (err) {
      logger.error(`[Daemon] Failed to handle message from server: ${msg.type}`, err);
      return errorClassOf(err);
    }
  }

  private armConnectTimeout(ws: WebSocketLike, startedAt: number, connectAttempt: ConnectAttemptSpan) {
    this.clearConnectTimeout();
    const ms = this.options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.connectTimeoutTimer = this.clock.setTimeout(() => {
      if (this.ws !== ws) return;
      if (!this.shouldConnect) return;
      if (ws.readyState !== WebSocket.CONNECTING) return;

      this.clearConnectTimeout();
      logger.warn(`[Daemon] WebSocket connection attempt timed out after ${ms}ms — forcing reconnect`);
      this.trace("daemon.connection.handshake_timeout", {
        connect_timeout_ms: ms,
        reconnect_attempt: this.reconnectAttempt,
        connect_age_ms_bucket: durationMsBucket(this.clock.now() - startedAt),
        ws_ready_state: ws.readyState,
        reconnecting: this.shouldConnect,
      }, "error", connectAttempt.context);
      connectAttempt.end("error", { outcome: "handshake_timeout" });

      try { ws.terminate(); } catch { /* ignore */ }
    }, ms);
  }

  /**
   * Task #374. Closed as the duplicate: log it once (this close) and wait the
   * long delay. Refused because the other connection still holds the key: wait
   * the long delay only if this process was itself closed as the duplicate
   * recently; otherwise this is a winner whose own socket dropped, which keeps
   * the normal backoff so it is back within the server's hold window.
   */
  private noteDuplicateMachineClose(reason: string) {
    const now = this.clock.now();
    if (reason === MACHINE_DUPLICATE_CONNECTION_CLOSE_REASON) {
      this.duplicateClosedAt = now;
      logger.error(
        "[Daemon] The server closed this connection: the same machine key is connected from another process. "
        + "Stop the other daemon or give this one its own machine key. "
        + `Reconnecting in ${Math.round(DaemonConnection.DUPLICATE_RECONNECT_DELAY_MS / 60_000)} minutes.`,
      );
      this.nextReconnectDelayOverrideMs = DaemonConnection.DUPLICATE_RECONNECT_DELAY_MS;
    } else {
      const recentlyClosedAsDuplicate = this.duplicateClosedAt !== null
        && now - this.duplicateClosedAt < DaemonConnection.DUPLICATE_MEMORY_MS;
      logger.warn(
        "[Daemon] The server refused this connection: another process holds this machine key"
        + (recentlyClosedAsDuplicate ? "; keeping the long reconnect delay." : "."),
      );
      if (recentlyClosedAsDuplicate) this.nextReconnectDelayOverrideMs = DaemonConnection.DUPLICATE_RECONNECT_DELAY_MS;
    }
    this.trace("daemon.connection.duplicate_machine_close", {
      close_reason: reason === MACHINE_DUPLICATE_CONNECTION_CLOSE_REASON ? "closed_as_duplicate" : "refused_held",
      long_delay: this.nextReconnectDelayOverrideMs !== null,
    });
  }

  private scheduleReconnect() {
    if (!this.shouldConnect) return;
    if (this.reconnectTimer) return;

    this.reconnectAttempt += 1;
    const override = this.nextReconnectDelayOverrideMs;
    this.nextReconnectDelayOverrideMs = null;
    const delayMs = override ?? (this.options.reconnectDelayFor ?? jitteredReconnectDelay)(this.reconnectDelay);
    logger.info(`[Daemon] Reconnecting to server in ${delayMs}ms (attempt ${this.reconnectAttempt})`);
    this.trace("daemon.connection.reconnect_scheduled", {
      reconnect_attempt: this.reconnectAttempt,
      delay_ms: delayMs,
      backoff_ms: this.reconnectDelay,
    });
    this.reconnectTimer = this.clock.setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, delayMs);

    // Exponential backoff
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  private resetWatchdog() {
    this.clearWatchdog();
    this.inboundProbeInFlight = false;
    this.scheduleWatchdogDeadline();
  }

  private scheduleWatchdogDeadline() {
    const ms = this.options.inboundWatchdogMs ?? INBOUND_WATCHDOG_MS;
    this.watchdogTimer = this.clock.setTimeout(() => {
      if (!this.inboundProbeInFlight && this.ws?.readyState === WebSocket.OPEN) {
        this.inboundProbeInFlight = true;
        logger.info(`[Daemon] No inbound traffic for ${ms / 1000}s — sending liveness probe`);
        this.trace("daemon.connection.inbound_probe_sent", {
          inbound_watchdog_ms: ms,
          last_inbound_message_kind: this.lastInboundMessageKind,
          last_inbound_age_ms_bucket: this.lastInboundAgeBucket(),
          ws_ready_state: this.ws.readyState,
          reconnecting: this.shouldConnect,
          cf_pop: this.cfPopValue,
        });
        try {
          this.ws.send(JSON.stringify({ type: "ping" } satisfies MachineToServerMessage));
        } catch (err) {
          this.trace("daemon.connection.inbound_probe_send_failed", {
            inbound_watchdog_ms: ms,
            error_class: errorClassOf(err),
            ws_ready_state: this.ws?.readyState ?? null,
            reconnecting: this.shouldConnect,
          }, "error");
          try { this.ws?.terminate(); } catch { /* ignore */ }
          return;
        }
        this.scheduleWatchdogDeadline();
        return;
      }

      logger.warn(`[Daemon] No inbound traffic after liveness probe — forcing reconnect${this.cfPopLogField()}`);
      this.trace("daemon.connection.watchdog_timeout", {
        inbound_watchdog_ms: ms,
        probe_in_flight: this.inboundProbeInFlight,
        last_inbound_message_kind: this.lastInboundMessageKind,
        last_inbound_age_ms_bucket: this.lastInboundAgeBucket(),
        ws_ready_state: this.ws?.readyState ?? null,
        reconnecting: this.shouldConnect,
        cf_pop: this.cfPopValue,
      }, "error");
      try { this.ws?.terminate(); } catch { /* ignore */ }
      // The close event will fire and scheduleReconnect() will run.
    }, ms);
  }

  private clearWatchdog() {
    if (this.watchdogTimer) {
      this.clock.clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private clearConnectTimeout() {
    if (this.connectTimeoutTimer) {
      this.clock.clearTimeout(this.connectTimeoutTimer);
      this.connectTimeoutTimer = null;
    }
  }

  private markInbound(messageKind: string) {
    this.lastInboundAt = this.clock.now();
    this.lastInboundMessageKind = messageKind;
  }

  private queueReplayableMessage(msg: MachineToServerMessage): OutboundDisposition {
    this.enqueueOrder.set(msg, this.nextEnqueueOrder++);
    if (msg.type === "agent:session:invalidate") {
      const latestLaunchId = this.latestObservedLaunchIdByAgent.get(msg.agentId);
      if (msg.launchId && latestLaunchId && msg.launchId !== latestLaunchId) {
        return { kind: "superseded" };
      }
      const replacedPending = this.pendingSessionInvalidationByAgent.has(msg.agentId);
      this.pendingSessionInvalidationByAgent.set(msg.agentId, msg);
      return { kind: "queued", agentId: msg.agentId, launchIdPresent: Boolean(msg.launchId), replacedPending };
    }
    if (msg.type === "agent:status") {
      // Latest status wins: it is the agent's current instance state, and the
      // server orders it against activity by the shared client sequence.
      const replacedPending = this.pendingStatusByAgent.has(msg.agentId);
      this.pendingStatusByAgent.set(msg.agentId, msg);
      return { kind: "queued", agentId: msg.agentId, launchIdPresent: Boolean(msg.launchId), replacedPending };
    }
    if (msg.type === "agent:runtime:ready") {
      // Latest wins, like status: a newer launch's readiness supersedes an older one's.
      const replacedPending = this.pendingRuntimeReadyByAgent.has(msg.agentId);
      this.pendingRuntimeReadyByAgent.set(msg.agentId, msg);
      return { kind: "queued", agentId: msg.agentId, launchIdPresent: true, replacedPending };
    }
    if (msg.type === "agent:credential:restored") {
      const key = credentialRestoredKey(msg);
      const replacedPending = this.pendingCredentialRestored.has(key);
      this.pendingCredentialRestored.set(key, msg);
      return { kind: "queued", agentId: msg.agentId, launchIdPresent: Boolean(msg.launchId), replacedPending };
    }
    if (msg.type !== "agent:activity") return { kind: "not_replayable" };
    const latestLaunchId = this.latestObservedLaunchIdByAgent.get(msg.agentId);
    if (msg.launchId && latestLaunchId && msg.launchId !== latestLaunchId) {
      this.trace("daemon.connection.pending_activity_invalidated", {
        reason: "launch_changed",
        outbound_message_kind: msg.type,
        agentId: msg.agentId,
        stale_launch_id_present: true,
        next_launch_id_present: true,
      });
      return { kind: "superseded" };
    }
    const replacedPending = this.pendingActivityByAgent.has(msg.agentId);
    this.pendingActivityByAgent.set(msg.agentId, msg);
    return { kind: "queued", agentId: msg.agentId, launchIdPresent: Boolean(msg.launchId), replacedPending };
  }

  private observeLaunchIdentity(msg: MachineToServerMessage) {
    const identity = this.agentLaunchIdentity(msg);
    if (!identity?.launchId) return;
    const latestLaunchId = this.latestObservedLaunchIdByAgent.get(identity.agentId);
    if (msg.type === "agent:session:invalidate" && latestLaunchId && latestLaunchId !== identity.launchId) {
      return;
    }
    if (msg.type !== "agent:activity" && msg.type !== "agent:session:invalidate") {
      this.latestObservedLaunchIdByAgent.set(identity.agentId, identity.launchId);
    }

    const pending = this.pendingActivityByAgent.get(identity.agentId);
    if (pending && pending.launchId !== identity.launchId) {
      this.pendingActivityByAgent.delete(identity.agentId);
      this.trace("daemon.connection.pending_activity_invalidated", {
        reason: "launch_changed",
        outbound_message_kind: msg.type,
        agentId: identity.agentId,
        stale_launch_id_present: Boolean(pending.launchId),
        next_launch_id_present: true,
      });
    }

    const pendingInvalidation = this.pendingSessionInvalidationByAgent.get(identity.agentId);
    if (!pendingInvalidation || pendingInvalidation.launchId === identity.launchId) return;
    this.pendingSessionInvalidationByAgent.delete(identity.agentId);
  }

  private agentLaunchIdentity(msg: MachineToServerMessage): { agentId: string; launchId?: string } | null {
    switch (msg.type) {
      case "agent:activity":
      case "agent:status":
      case "agent:session":
      case "agent:session:invalidate":
      case "agent:runtime_profile":
      case "agent:runtime_profile:migration:ack":
      case "agent:runtime_profile:migration_done":
      case "agent:runtime_profile:daemon_release_notice:ack":
        return { agentId: msg.agentId, launchId: msg.launchId };
      default:
        return null;
    }
  }

  private flushPendingActivity(ws: WebSocketLike) {
    if (
      this.pendingActivityByAgent.size === 0
      && this.pendingStatusByAgent.size === 0
      && this.pendingRuntimeReadyByAgent.size === 0
      && this.pendingCredentialRestored.size === 0
    ) return;
    if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;

    const statuses = [...this.pendingStatusByAgent.values()];
    const activities = [...this.pendingActivityByAgent.values()];
    const readies = [...this.pendingRuntimeReadyByAgent.values()];
    const restored = [...this.pendingCredentialRestored.values()];
    this.pendingStatusByAgent.clear();
    this.pendingActivityByAgent.clear();
    this.pendingRuntimeReadyByAgent.clear();
    this.pendingCredentialRestored.clear();
    // Agents replay in the order their frames were first queued; within one
    // agent, status, activity, readiness and credential restores go out in the order they were
    // produced (queue order; for status and activity this is also the shared
    // client sequence).
    const byAgent = new Map<string, MachineToServerMessage[]>();
    for (const msg of [...activities, ...statuses, ...readies, ...restored]) {
      const agentId = (msg as { agentId: string }).agentId;
      const frames = byAgent.get(agentId) ?? [];
      frames.push(msg);
      byAgent.set(agentId, frames);
    }
    const pending = [...byAgent.values()].flatMap((frames) => [...frames].sort((a, b) =>
      (this.enqueueOrder.get(a) ?? 0) - (this.enqueueOrder.get(b) ?? 0)));
    for (const msg of pending) {
      ws.send(JSON.stringify(msg));
      this.traceActivitySent(msg, "replay");
    }
    if (readies.length > 0) {
      this.trace("daemon.connection.outbound_replayed", {
        outbound_message_kind: "agent:runtime:ready",
        message_count: readies.length,
      });
    }
    if (restored.length > 0) {
      this.trace("daemon.connection.outbound_replayed", {
        outbound_message_kind: "agent:credential:restored",
        message_count: restored.length,
      });
    }
    if (activities.length > 0) {
      this.trace("daemon.connection.outbound_replayed", {
        outbound_message_kind: "agent:activity",
        message_count: activities.length,
      });
    }
    if (statuses.length > 0) {
      this.trace("daemon.connection.outbound_replayed", {
        outbound_message_kind: "agent:status",
        message_count: statuses.length,
      });
    }
  }

  private flushPendingSessionInvalidations(ws: WebSocketLike) {
    if (this.pendingSessionInvalidationByAgent.size === 0) return;
    if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;

    const pending = [...this.pendingSessionInvalidationByAgent.values()];
    this.pendingSessionInvalidationByAgent.clear();
    for (const msg of pending) {
      ws.send(JSON.stringify(msg));
    }
  }

  private traceActivitySent(msg: MachineToServerMessage, sendPath: "websocket_open" | "replay"): void {
    if (msg.type !== "agent:activity") return;
    this.trace("daemon.agent.activity.sent", {
      agentId: msg.agentId,
      agent_id: msg.agentId,
      activity: msg.activity,
      detail_present: Boolean(msg.detail),
      entry_kinds: (msg.entries ?? []).map((entry) => entry.kind).join(","),
      launchId: msg.launchId,
      launch_id: msg.launchId,
      launch_id_present: Boolean(msg.launchId),
      daemonInstanceId: msg.daemonInstanceId,
      daemon_instance_id: msg.daemonInstanceId,
      daemon_instance_id_present: Boolean(msg.daemonInstanceId),
      clientSeq: msg.clientSeq,
      client_seq: msg.clientSeq,
      client_seq_present: typeof msg.clientSeq === "number",
      // The fact id and its presence flag used to be emitted here. Both were
      // dead: this span has no contract entry, so the local sink is what
      // decides, and it scrubs `producer_fact_id` under the #460 ruling —
      // leaving a flag that asserted a field the record did not carry.
      // Removed per @Leiysky's #422 item-3 determination; a "blocked key was
      // seen" signal belongs to the dropped-attribute counter (#422 item 1),
      // not to a span flag that only the emitter can read.
      //
      // correlation_id is always the synthetic key, as on `.produced`
      // (activitySink.ts). The fact id is a banned join key (#460), so writing
      // it here put the same value on disk under an allowed name (task #423).
      correlation_id: `agent:${msg.agentId}:daemonActivity:${msg.launchId ?? "legacy"}:${msg.clientSeq ?? "unsequenced"}`,
      probe_id_present: Boolean(msg.probeId),
      send_path: sendPath,
    });
  }

  /** Log suffix naming the CloudFront PoP; empty when the connection has none. */
  private cfPopLogField(): string {
    return this.cfPopValue ? `, cf_pop=${this.cfPopValue}` : "";
  }

  private lastInboundAgeBucket(): string {
    return durationMsBucket(this.lastInboundAt == null ? null : this.clock.now() - this.lastInboundAt);
  }

  private trace(name: string, attrs?: Record<string, unknown>, status: TraceStatus = "ok", parent?: TraceContext | null) {
    this.options.onTraceEvent?.(name, attrs, status, parent);
  }
}

// One connect attempt ends at the first of open, error, handshake reject,
// handshake timeout or close. Later calls to end are ignored.
class ConnectAttemptSpan {
  private open = true;

  constructor(private readonly span: ActiveSpan) {}

  get context(): TraceContext {
    return this.span.context;
  }

  get isOpen(): boolean {
    return this.open;
  }

  end(status: TraceStatus, attrs: Record<string, unknown>): void {
    if (!this.open) return;
    this.open = false;
    this.span.end(status, { attrs });
  }
}

export { buildWebSocketOptions };
