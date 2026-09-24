import type { ClientRequest, IncomingMessage } from "node:http";
import WebSocket from "ws";
import {
  clearClockTimeout,
  currentTimeMs,
  setClockTimeout,
  type ServerToMachineMessage,
  type MachineToServerMessage,
  type TraceStatus,
} from "@botiverse/raft-shared";
import { logger } from "./logger.js";
import { buildWebSocketOptions } from "./proxy.js";

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
  onTraceEvent?: (name: string, attrs?: Record<string, unknown>, status?: TraceStatus) => void;
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

export class DaemonConnection {
  private ws: WebSocketLike | null = null;
  private options: ConnectionOptions;
  private readonly clock: Clock;
  private reconnectTimer: unknown = null;
  private watchdogTimer: unknown = null;
  private connectTimeoutTimer: unknown = null;
  private reconnectDelay: number;
  private readonly maxReconnectDelay = 30000;
  private shouldConnect = true;
  private reconnectAttempt = 0;
  private lastDroppedSendLogAt = 0;
  private lastInboundAt: number | null = null;
  private lastInboundMessageKind: string | null = null;
  private inboundProbeInFlight = false;
  private readonly pendingActivityByAgent = new Map<string, AgentActivityMessage>();
  private readonly pendingSessionInvalidationByAgent = new Map<
    string,
    Extract<MachineToServerMessage, { type: "agent:session:invalidate" }>
  >();
  private readonly latestObservedLaunchIdByAgent = new Map<string, string>();

  constructor(options: ConnectionOptions) {
    this.options = options;
    this.clock = options.clock ?? systemClock;
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
    this.pendingSessionInvalidationByAgent.clear();
    this.clearWatchdog();
    this.clearConnectTimeout();
    if (this.reconnectTimer) {
      this.clock.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      logger.info("[Daemon] Disconnect requested");
      this.ws.close();
      this.ws = null;
    }
  }

  send(msg: MachineToServerMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.observeLaunchIdentity(msg);
      if (msg.type === "agent:activity") {
        this.pendingActivityByAgent.delete(msg.agentId);
      }
      if (msg.type === "agent:session:invalidate") {
        this.pendingSessionInvalidationByAgent.delete(msg.agentId);
      }
      this.ws.send(JSON.stringify(msg));
      this.traceActivitySent(msg, "websocket_open");
      return;
    }

    this.observeLaunchIdentity(msg);
    this.queueReplayableMessage(msg);

    const now = this.clock.now();
    if (now - this.lastDroppedSendLogAt > 5000) {
      this.lastDroppedSendLogAt = now;
      logger.warn(`[Daemon] Dropping outbound message while disconnected: ${msg.type}`);
    }
    this.trace("daemon.connection.outbound_dropped", {
      outbound_message_kind: msg.type,
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
    this.trace("daemon.connection.connecting", {
      reconnect_attempt: this.reconnectAttempt,
      server_url_present: Boolean(this.options.serverUrl),
      proxy_present: Boolean(wsOptions?.agent),
    });

    const ws: WebSocketLike = this.options.wsFactory ? this.options.wsFactory(wsUrl, wsOptions) : new WebSocket(wsUrl, wsOptions);
    this.ws = ws;
    let handshakeRejected = false;
    const connectStartedAt = this.clock.now();
    this.armConnectTimeout(ws, connectStartedAt);

    ws.on("open", () => {
      if (this.ws !== ws) return;
      if (!this.shouldConnect) return; // disconnect() was called before open fired
      this.clearConnectTimeout();
      logger.info("[Daemon] Connected to server");
      const priorReconnectAttempt = this.reconnectAttempt;
      this.reconnectAttempt = 0;
      this.reconnectDelay = this.options.minReconnectDelayMs ?? 1000; // Reset backoff
      this.markInbound("websocket_open");
      this.resetWatchdog();
      this.trace("daemon.connection.connected", {
        reconnect_attempt: priorReconnectAttempt,
        inbound_watchdog_ms: this.options.inboundWatchdogMs ?? INBOUND_WATCHDOG_MS,
      });
      this.flushPendingSessionInvalidations(ws);
      this.flushPendingActivity(ws);
      this.options.onConnect();
    });

    ws.on("message", (data: Buffer) => {
      if (this.ws !== ws) return;
      let messageKind = "unknown";
      try {
        const msg: ServerToMachineMessage = JSON.parse(data.toString());
        messageKind = msg.type;
        this.markInbound(messageKind);
        this.resetWatchdog();
        if (messageKind !== "ping") {
          this.trace("daemon.connection.inbound_received", {
            inbound_message_kind: messageKind,
            last_inbound_age_ms_bucket: "0",
          });
        }
        this.options.onMessage(msg);
      } catch (err) {
        this.markInbound("invalid_json");
        this.resetWatchdog();
        logger.error("[Daemon] Invalid message from server", err);
        this.trace("daemon.connection.invalid_message", {
          error_class: err instanceof Error ? err.name : typeof err,
          last_inbound_message_kind: "invalid_json",
        }, "error");
      }
    });

    ws.on("close", (code, reasonBuffer) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearConnectTimeout();
      this.clearWatchdog();
      const reason = reasonBuffer.toString("utf8");
      logger.warn(
        `[Daemon] Disconnected from server (code=${code}, reason=${JSON.stringify(reason)}, reconnecting=${this.shouldConnect})`,
      );
      this.trace("daemon.connection.disconnected", {
        close_code: code,
        close_reason_present: Boolean(reason),
        reconnecting: this.shouldConnect,
        reconnect_attempt: this.reconnectAttempt,
        last_inbound_message_kind: this.lastInboundMessageKind,
        last_inbound_age_ms_bucket: this.lastInboundAgeBucket(),
      }, this.shouldConnect ? "cancelled" : "ok");
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
      logger.error(`[Daemon] WebSocket handshake rejected (status=${statusCode}${reasonText})`);
      this.trace("daemon.connection.handshake_rejected", {
        status_code: statusCode,
        slock_reason_present: Boolean(reason),
        slock_reason: reason,
      }, "error");
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
      }, "error");
      // 'close' will fire after this
    });
  }

  private armConnectTimeout(ws: WebSocketLike, startedAt: number) {
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
      }, "error");

      try { ws.terminate(); } catch { /* ignore */ }
    }, ms);
  }

  private scheduleReconnect() {
    if (!this.shouldConnect) return;
    if (this.reconnectTimer) return;

    this.reconnectAttempt += 1;
    logger.info(`[Daemon] Reconnecting to server in ${this.reconnectDelay}ms (attempt ${this.reconnectAttempt})`);
    this.trace("daemon.connection.reconnect_scheduled", {
      reconnect_attempt: this.reconnectAttempt,
      delay_ms: this.reconnectDelay,
    });
    this.reconnectTimer = this.clock.setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, this.reconnectDelay);

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
        });
        try {
          this.ws.send(JSON.stringify({ type: "ping" } satisfies MachineToServerMessage));
        } catch (err) {
          this.trace("daemon.connection.inbound_probe_send_failed", {
            inbound_watchdog_ms: ms,
            error_class: err instanceof Error ? err.name : typeof err,
            ws_ready_state: this.ws?.readyState ?? null,
            reconnecting: this.shouldConnect,
          }, "error");
          try { this.ws?.terminate(); } catch { /* ignore */ }
          return;
        }
        this.scheduleWatchdogDeadline();
        return;
      }

      logger.warn(`[Daemon] No inbound traffic after liveness probe — forcing reconnect`);
      this.trace("daemon.connection.watchdog_timeout", {
        inbound_watchdog_ms: ms,
        probe_in_flight: this.inboundProbeInFlight,
        last_inbound_message_kind: this.lastInboundMessageKind,
        last_inbound_age_ms_bucket: this.lastInboundAgeBucket(),
        ws_ready_state: this.ws?.readyState ?? null,
        reconnecting: this.shouldConnect,
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

  private queueReplayableMessage(msg: MachineToServerMessage) {
    if (msg.type === "agent:session:invalidate") {
      const latestLaunchId = this.latestObservedLaunchIdByAgent.get(msg.agentId);
      if (msg.launchId && latestLaunchId && msg.launchId !== latestLaunchId) {
        return;
      }
      this.pendingSessionInvalidationByAgent.set(msg.agentId, msg);
      return;
    }
    if (msg.type !== "agent:activity") return;
    const latestLaunchId = this.latestObservedLaunchIdByAgent.get(msg.agentId);
    if (msg.launchId && latestLaunchId && msg.launchId !== latestLaunchId) {
      this.trace("daemon.connection.pending_activity_invalidated", {
        reason: "launch_changed",
        outbound_message_kind: msg.type,
        agentId: msg.agentId,
        stale_launch_id_present: true,
        next_launch_id_present: true,
      });
      return;
    }
    this.pendingActivityByAgent.set(msg.agentId, msg);
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
    if (this.pendingActivityByAgent.size === 0) return;
    if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;

    const pending = [...this.pendingActivityByAgent.values()];
    this.pendingActivityByAgent.clear();
    for (const msg of pending) {
      ws.send(JSON.stringify(msg));
      this.traceActivitySent(msg, "replay");
    }
    this.trace("daemon.connection.outbound_replayed", {
      outbound_message_kind: "agent:activity",
      message_count: pending.length,
    });
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
      producerFactId: msg.producerFactId,
      producer_fact_id: msg.producerFactId,
      producer_fact_id_present: Boolean(msg.producerFactId),
      correlation_id: msg.producerFactId ?? `agent:${msg.agentId}:daemonActivity:${msg.launchId ?? "legacy"}:${msg.clientSeq ?? "unsequenced"}`,
      probe_id_present: Boolean(msg.probeId),
      send_path: sendPath,
    });
  }

  private lastInboundAgeBucket(): string {
    return durationMsBucket(this.lastInboundAt == null ? null : this.clock.now() - this.lastInboundAt);
  }

  private trace(name: string, attrs?: Record<string, unknown>, status: TraceStatus = "ok") {
    this.options.onTraceEvent?.(name, attrs, status);
  }
}

export { buildWebSocketOptions };
