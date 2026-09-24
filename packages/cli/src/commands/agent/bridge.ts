import { randomUUID } from "node:crypto";

import type { Command } from "commander";
import {
  EXTERNAL_AGENT_ACTIVITY_EVENT_SCHEMA,
  EXTERNAL_AGENT_ACTIVITY_INGEST_SCHEMA,
  currentTimeMs,
} from "@botiverse/raft-shared";
import type {
  DaemonApiRequestBodyByRoute,
  DaemonApiRequestQueryByRoute,
  DaemonApiResponseByRoute,
} from "@botiverse/raft-shared";

import type { ApiResponse, BodyResponse } from "../../client.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import { writeDiagnostic, writeText, NL, adoptCliReplyText } from "../../core/renderer.js";
import { formatBridgeRecovered, formatBridgeStreamFallback, formatBridgeTransientFailure } from "./_format.js";
import { createDaemonApiSurfaceClient } from "../../daemonApiPath.js";
import {
  AgentCommsBridgeLockError,
  acquireAgentCommsBridgeLock,
  createFileAgentCommsBridgeStore,
  runAgentCommsBridgeOnce,
  runAgentCommsBridgeReconcile,
  type AgentCommsActivityDrainSource,
  type AgentCommsActivitySink,
  type AgentCommsWakeHintSource,
  type AgentCommsWakeHintFetchResult,
} from "../../agentCommsCore/bridge.js";
import { createRaftChannelWakeAdapter } from "../../external/raftChannelWakeAdapter.js";

interface BridgeOptions {
  expectedAgent?: string;
  json?: boolean;
  once?: boolean;
  pollIntervalMs?: string;
  stateDir?: string;
  adapterInstance?: string;
  limit?: string;
  wakeAdapter?: string;
  wakeChannelEndpoint?: string;
  wakeChannelToken?: string;
  runtimeSession?: string;
  reconcileIntervalMs?: string;
  fastReconcileDelayMs?: string;
  activityChannelEndpoint?: string;
  activityChannelToken?: string;
  activityDrainLimit?: string;
}

interface DaemonApiBridgeClient {
  wakeHints: {
    fetch(query: DaemonApiRequestQueryByRoute["wakeHintsFetch"]): Promise<ApiResponse<DaemonApiResponseByRoute["wakeHintsFetch"]>>;
  };
  activity: {
    forward(body: DaemonApiRequestBodyByRoute["activityForward"]): Promise<ApiResponse<DaemonApiResponseByRoute["activityForward"]>>;
  };
}

interface WakeHintStreamClient {
  streamWakeHints?(query: URLSearchParams): Promise<BodyResponse>;
}

export const agentBridgeCommand = defineCommand(
  {
    name: "bridge",
    description: "Run the explicit long-lived Agent CommsCore bridge for self-hosted runtime wake integrations.",
    options: [
      { flags: "--json", description: "Emit newline-delimited JSON protocol events." },
      { flags: "--expected-agent <id>", description: "Independently expected Agent id (env: RAFT_EXPECTED_AGENT_ID). The bridge sends nothing if it differs from the profile identity." },
      { flags: "--once", description: "Run one receive/replay iteration, then exit." },
      { flags: "--poll-interval-ms <ms>", description: "Polling interval for the long-running bridge loop." },
      { flags: "--state-dir <path>", description: "Override bridge state directory for tests/debugging." },
      { flags: "--adapter-instance <id>", description: "Wake adapter instance id for per-agent state partitioning." },
      { flags: "--limit <n>", description: "Maximum events to pull per iteration." },
      { flags: "--wake-adapter <kind>", description: "Enable a wake adapter. Supported: wake-channel." },
      { flags: "--wake-channel-endpoint <url>", description: "Localhost wake endpoint exposed by the runtime's Raft channel plugin (see docs/wake-endpoint-contract.md in raft-external-agents)." },
      { flags: "--wake-channel-token <token>", description: "Optional shared token for the Raft channel wake endpoint (env: RAFT_CHANNEL_TOKEN)." },
      { flags: "--runtime-session <id>", description: "Optional runtime session id when the adapter endpoint does not return one." },
      { flags: "--activity-channel-endpoint <url>", description: "Localhost activity drain endpoint exposed by the runtime's Raft channel plugin. Defaults to /activity/drain derived from --wake-channel-endpoint." },
      { flags: "--activity-channel-token <token>", description: "Optional shared token for the activity drain endpoint (env: RAFT_CHANNEL_TOKEN)." },
      { flags: "--activity-drain-limit <n>", description: "Maximum plugin activity events to drain per bridge iteration." },
    ],
  },
  async (ctx, options: BridgeOptions) => {
    const agentContext = ctx.loadAgentContext();
    if (agentContext.clientMode !== "self-hosted-runner") {
      throw new CliError({
        code: "BRIDGE_REQUIRES_PROFILE",
        message: "raft agent bridge requires a self-hosted profile credential, not daemon-injected runner auth.",
        suggestedNextAction: "Run it as `raft --profile <slug> agent bridge --json`; create the profile with `raft agent login` if needed.",
      });
    }

    // A profile is a credential selector, not an independent proof that the
    // bridge is acting as the Agent the launcher intended. Bind that intent
    // separately and compare before constructing an API client or performing
    // any network effect. The plugin/start command can carry the expected id
    // without duplicating or inspecting the credential file.
    const expectedAgentId = options.expectedAgent ?? ctx.env.RAFT_EXPECTED_AGENT_ID;
    if (!expectedAgentId) {
      throw new CliError({
        code: "BRIDGE_EXPECTED_AGENT_REQUIRED",
        message: "raft agent bridge requires an independently expected Agent id.",
        suggestedNextAction: "Set RAFT_EXPECTED_AGENT_ID to the Agent id from the Raft setup surface, or pass --expected-agent <id>.",
      });
    }
    if (expectedAgentId !== agentContext.agentId) {
      throw new CliError({
        code: "BRIDGE_IDENTITY_MISMATCH",
        message: `The selected profile resolves to Agent ${agentContext.agentId}, but this bridge was started for Agent ${expectedAgentId}. No request was sent.`,
        suggestedNextAction: "Select the profile for the expected Agent, then restart the bridge.",
      });
    }

    const pollIntervalMs = parsePositiveInt(options.pollIntervalMs, 5000, "poll-interval-ms");
    const reconcileIntervalMs = options.reconcileIntervalMs === "0"
      ? 0
      : parsePositiveInt(options.reconcileIntervalMs, 120_000, "reconcile-interval-ms");
    const fastReconcileDelayMs = options.fastReconcileDelayMs === "0"
      ? 0
      : parsePositiveInt(options.fastReconcileDelayMs, 3000, "fast-reconcile-delay-ms");
    const limit = parsePositiveInt(options.limit, 50, "limit");
    const activityDrainLimit = parsePositiveInt(options.activityDrainLimit, 50, "activity-drain-limit");
    const client = ctx.createApiClient(agentContext);
    const daemonApi = createDaemonApiSurfaceClient(client);
    const pollSource = createDaemonApiWakeHintSource(daemonApi);
    const streamSource = options.once ? null : createDaemonApiWakeHintStreamSource(client, ctx.env);
    const wakeAdapter = createWakeAdapter(options, ctx.env);
    const activitySource = createActivityDrainSource(options, ctx.env);
    const activitySink = createDaemonApiActivitySink(daemonApi);
    let bridgeLock;
    try {
      bridgeLock = acquireAgentCommsBridgeLock({
        agentContext,
        env: ctx.env,
        stateDir: options.stateDir,
        adapterInstance: options.adapterInstance,
      });
    } catch (err) {
      if (err instanceof AgentCommsBridgeLockError) {
        throw new CliError({
          code: err.code,
          message: "raft agent bridge is already running for this profile/agent/adapter state.",
          suggestedNextAction: `Stop the existing bridge or use a different --adapter-instance. Lock: ${err.lockPath}`,
        });
      }
      throw err;
    }
    // Persistent observability sink (task #87, xxchan): every protocol /
    // lifecycle event also lands in <state-dir>/bridge.log regardless of
    // --json, because the plugin supervisor swallows stdout into deep CC MCP
    // logs. One tail answers "why didn't it wake".
    const logStore = createFileAgentCommsBridgeStore({
      agentContext,
      env: ctx.env,
      stateDir: options.stateDir,
      adapterInstance: options.adapterInstance,
    });
    const emit = (value: unknown) => {
      logStore.appendLog(value as Record<string, unknown>);
      if (options.json) {
        writeText(ctx.io, adoptCliReplyText(JSON.stringify(value)), NL);
      }
    };

    try {
      let replayPending = true;
      let consecutiveFailures = 0;
      let mode: "stream" | "poll" = streamSource ? "stream" : "poll";
      let pollFallbackOnce = false;
      // EAB invariant 7 (at-least-once-until-consumed): hint key -> last
      // inject epoch-ms, so the reconcile re-peek skips wakes injected
      // within the grace window instead of doubling a live wake.
      const recentInjections = new Map<string, number>();
      const reconcileGraceMs = Math.min(30_000, Math.max(1, Math.floor(reconcileIntervalMs / 2)) || 30_000);
      let lastReconcileAt = Date.now();
      let fastReconcileAt: number | null = null;
      let sawHandoffThisIteration = false;
      emit({ type: "bridge_process_started", pid: process.pid, mode, pollIntervalMs, reconcileIntervalMs });
      do {
        const source = mode === "stream" && streamSource ? streamSource : pollSource;
        try {
          const events = await runAgentCommsBridgeOnce({
            agentContext,
            source,
            env: ctx.env,
            stateDir: options.stateDir,
            adapterInstance: options.adapterInstance,
            limit,
            replayPending,
            wakeAdapter,
            runtimeSession: options.runtimeSession ?? null,
            activitySource,
            activitySink,
            activityDrainLimit,
            recentInjections,
          });
          for (const event of events) emit(event);
          if (consecutiveFailures > 0) {
            emit({ type: "bridge_recovered", afterFailures: consecutiveFailures });
            writeDiagnostic(ctx.io, formatBridgeRecovered(consecutiveFailures));
            consecutiveFailures = 0;
          }
          replayPending = false;
          sawHandoffThisIteration = events.some((e: any) => e.type === "agent_comms.handoff");
          if (fastReconcileDelayMs > 0 && sawHandoffThisIteration) {
            fastReconcileAt = Date.now() + fastReconcileDelayMs;
          }
        } catch (err) {
          // `--once` is the debug/scripted single-shot: surface the error.
          if (options.once || classifyBridgeLoopError(err) === "fatal") {
            if (!(mode === "stream" && isWakeStreamUnavailable(err))) {
              const errorCode = err instanceof CliError ? err.code : (err as Error)?.name ?? "Error";
              const message = ((err as Error)?.message ?? String(err)).slice(0, 200);
              emit({ type: "bridge_fatal", errorCode, message });
              await forwardBridgeFatalActivity({
                sink: activitySink,
                errorCode,
                message,
                emit,
              });
            }
            if (mode === "stream" && isWakeStreamUnavailable(err)) {
              mode = "poll";
              emit({ type: "bridge_stream_unavailable", fallback: "poll", message: (err as Error).message });
              writeDiagnostic(ctx.io, formatBridgeStreamFallback());
              continue;
            }
            throw err;
          }
          // At-most-once local replay per bridge process (Stone, #2783
          // review): runAgentCommsBridgeOnce replays locally accepted
          // pending hints BEFORE fetching /wake-hints, so by the time any
          // retryable failure surfaces here the replay (if requested) has
          // already injected. Leaving replayPending=true would re-inject
          // the same pending hints into the live session on every backoff
          // attempt while the server is down.
          replayPending = false;
          consecutiveFailures += 1;
          const delayMs = bridgeRetryDelayMs(consecutiveFailures, pollIntervalMs);
          const errorCode = err instanceof CliError ? err.code : (err as Error)?.name ?? "Error";
          const message = ((err as Error)?.message ?? String(err)).slice(0, 200);
          emit({ type: "bridge_retry", consecutiveFailures, delayMs, errorCode, message });
          // Visible degradation signal regardless of --json (D5: degrade
          // loudly; the step0 fallback stays available meanwhile).
          writeDiagnostic(ctx.io, formatBridgeTransientFailure(errorCode, message, consecutiveFailures, delayMs));
          await sleep(delayMs);
          if (mode === "stream") {
            pollFallbackOnce = true;
            mode = "poll";
          }
          continue;
        }

        if (options.once) break;
        const shouldFastReconcile = fastReconcileAt !== null && Date.now() >= fastReconcileAt;
        const shouldRegularReconcile = reconcileIntervalMs > 0 && Date.now() - lastReconcileAt >= reconcileIntervalMs;
        if (shouldFastReconcile || shouldRegularReconcile) {
          if (shouldRegularReconcile) lastReconcileAt = Date.now();
          fastReconcileAt = null;
          try {
            const reconcile = await runAgentCommsBridgeReconcile({
              agentContext,
              source: pollSource,
              env: ctx.env,
              stateDir: options.stateDir,
              adapterInstance: options.adapterInstance,
              limit,
              wakeAdapter,
              runtimeSession: options.runtimeSession ?? null,
              recentInjections,
              graceMs: shouldFastReconcile && !shouldRegularReconcile ? 0 : reconcileGraceMs,
            });
            for (const event of reconcile.events) emit(event);
            emit({
              type: shouldFastReconcile && !shouldRegularReconcile ? "fast_reconcile_peek" : "reconcile_peek",
              pendingCount: reconcile.pendingCount,
              reinjectedCount: reconcile.reinjectedCount,
              skippedRecentCount: reconcile.skippedRecentCount,
            });
          } catch (err) {
            // Reconciliation is a safety net; its own failures must not take
            // the bridge down. The main loop's retry path covers the server.
            const message = ((err as Error)?.message ?? String(err)).slice(0, 200);
            emit({ type: "reconcile_failed", message });
          }
        }
        if (mode === "stream") {
          if (fastReconcileAt !== null
            && Date.now() >= fastReconcileAt
            && !sawHandoffThisIteration) {
            pollFallbackOnce = true;
            mode = "poll";
          }
          continue;
        }
        if (pollFallbackOnce && streamSource) {
          pollFallbackOnce = false;
          mode = "stream";
          continue;
        }
        await sleep(pollIntervalMs);
      } while (true);
    } finally {
      await streamSource?.close();
      bridgeLock.release();
    }
  },
);

export function registerAgentBridgeCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, agentBridgeCommand, runtimeOptions);
}

function createDaemonApiWakeHintSource(client: DaemonApiBridgeClient): AgentCommsWakeHintSource {
  return {
    async fetchWakeHints(input): Promise<AgentCommsWakeHintFetchResult> {
      const response = await client.wakeHints.fetch({
        since: input.since,
        limit: input.limit,
      });
      if (!response.ok) {
        throw new CliError({
          code: response.status >= 500 ? "SERVER_5XX" : "BRIDGE_WAKE_HINTS_FAILED",
          message: response.error ?? `HTTP ${response.status}`,
        });
      }
      return {
        hints: response.data?.hints ?? response.data?.wake_hints ?? [],
        last_seen_hint_seq: response.data?.last_seen_hint_seq ?? response.data?.last_hint_seq ?? null,
        has_more: response.data?.has_more ?? false,
      };
    },
  };
}

function createDaemonApiWakeHintStreamSource(client: WakeHintStreamClient, env: NodeJS.ProcessEnv = process.env): (AgentCommsWakeHintSource & { close(): Promise<void> }) | null {
  if (!client.streamWakeHints) return null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let bufferedText = "";
  let pendingEvent: SseEvent = {};
  const idleTimeoutMs = parseWakeStreamIdleTimeoutMs(env);

  async function close(): Promise<void> {
    const current = reader;
    reader = null;
    bufferedText = "";
    pendingEvent = {};
    if (current) await current.cancel().catch(() => undefined);
  }

  async function ensureReader(since: number | "latest"): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    if (reader) return reader;
    const query = new URLSearchParams({ since: String(since) });
    const response = await client.streamWakeHints!(query);
    if (!response.ok) {
      throw new CliError({
        code: response.status === 404 || response.status === 405 || response.status === 501
          ? "BRIDGE_WAKE_STREAM_UNAVAILABLE"
          : response.status >= 500
            ? "SERVER_5XX"
            : "BRIDGE_WAKE_STREAM_FAILED",
        message: response.error ?? `HTTP ${response.status}`,
      });
    }
    if (!response.response.body) {
      throw new TypeError("wake-hint stream response has no body");
    }
    reader = response.response.body.getReader();
    return reader;
  }

  async function nextEvent(since: number | "latest"): Promise<AgentCommsWakeHintFetchResult> {
    const decoder = new TextDecoder();
    while (true) {
      try {
        const buffered = drainSseEvents();
        if (buffered) return buffered;
      } catch (err) {
        await close();
        const message = err instanceof Error ? err.message : String(err);
        throw new TypeError(`wake-hint stream parse failed: ${message}`);
      }

      const current = await ensureReader(since);
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await readWithIdleWatchdog(current, idleTimeoutMs);
      } catch (err) {
        await close();
        throw err;
      }
      const { done, value } = chunk;
      if (done) {
        await close();
        throw new TypeError("wake-hint stream ended");
      }
      bufferedText += decoder.decode(value, { stream: true });
      let result: AgentCommsWakeHintFetchResult | null;
      try {
        result = drainSseEvents();
      } catch (err) {
        await close();
        const message = err instanceof Error ? err.message : String(err);
        throw new TypeError(`wake-hint stream parse failed: ${message}`);
      }
      if (result) return result;
      // Heartbeat/comment/partial chunk: yield an empty result instead of
      // blocking until the next real wake event. A healthy-but-quiet stream
      // sends `: ka` comments every 25s, and staying inside this read loop
      // starved the outer loop's reconcile timer forever (Stone's #2805
      // blocker) — EAB-7 must be bounded-time even when no new wake arrives.
      // Parser state (bufferedText/pendingEvent) persists across calls, so
      // split SSE frames still assemble correctly.
      return { hints: [], last_seen_hint_seq: null, has_more: false };
    }
  }

  function drainSseEvents(): AgentCommsWakeHintFetchResult | null {
    while (true) {
      const newline = bufferedText.indexOf("\n");
      if (newline < 0) return null;
      const rawLine = bufferedText.slice(0, newline);
      bufferedText = bufferedText.slice(newline + 1);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line === "") {
        const result = sseEventToWakeHints(pendingEvent);
        pendingEvent = {};
        if (result) return result;
        continue;
      }
      if (line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = separator >= 0 ? line.slice(0, separator) : line;
      const value = separator >= 0
        ? line.slice(separator + (line[separator + 1] === " " ? 2 : 1))
        : "";
      if (field === "event") pendingEvent.event = value;
      if (field === "id") pendingEvent.id = value;
      if (field === "data") pendingEvent.data = pendingEvent.data === undefined ? value : `${pendingEvent.data}\n${value}`;
    }
  }

  return {
    async fetchWakeHints(input): Promise<AgentCommsWakeHintFetchResult> {
      return nextEvent(input.since);
    },
    close,
  };
}

interface SseEvent {
  event?: string;
  id?: string;
  data?: string;
}

function sseEventToWakeHints(event: SseEvent): AgentCommsWakeHintFetchResult | null {
  if (!event.data || (event.event && event.event !== "wake-hint")) return null;
  const parsed = JSON.parse(event.data) as AgentCommsWakeHintFetchResult["hints"][number];
  const eventSeq = Number(event.id);
  const hint = {
    ...parsed,
    ...(!Number.isNaN(eventSeq) && typeof parsed.seq !== "number" ? { seq: eventSeq } : {}),
  };
  const seq = typeof hint.seq === "number" ? hint.seq : Number.isNaN(eventSeq) ? null : eventSeq;
  return {
    hints: [hint],
    last_seen_hint_seq: seq,
    has_more: false,
  };
}

function readWithIdleWatchdog(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new TypeError(`wake-hint stream idle timeout after ${idleTimeoutMs}ms`));
    }, idleTimeoutMs);
  });
  return Promise.race([reader.read(), timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

const BRIDGE_WAKE_STREAM_IDLE_TIMEOUT_MS = 60_000;

function parseWakeStreamIdleTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.SLOCK_BRIDGE_WAKE_STREAM_IDLE_TIMEOUT_MS;
  if (raw === undefined) return BRIDGE_WAKE_STREAM_IDLE_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : BRIDGE_WAKE_STREAM_IDLE_TIMEOUT_MS;
}

function isWakeStreamUnavailable(err: unknown): boolean {
  return err instanceof CliError && err.code === "BRIDGE_WAKE_STREAM_UNAVAILABLE";
}

/**
 * D5 backoff-then-degrade (rfcs/035, task #71): the long-running poll loop
 * must survive transient server unavailability (staging deploys restart the
 * server several times a day and used to kill every running bridge), while
 * still failing closed on anything that polling cannot heal.
 *
 * Retryable = the server/transport being momentarily unreachable:
 * - CliError SERVER_5XX (HTTP 5xx from the wake-hints surface), and
 * - non-CliError transport throws from fetch (connection refused/reset,
 *   DNS, timeouts, abrupt undici socket termination — the deploy-restart
 *   signature).
 * Everything else (4xx incl. revoked credentials, unknown errors) is FATAL:
 * retrying cannot fix it and looping would hide a real failure.
 */
export function classifyBridgeLoopError(err: unknown): "retryable" | "fatal" {
  if (err instanceof CliError) {
    return err.code === "SERVER_5XX" ? "retryable" : "fatal";
  }
  if (err instanceof Error) {
    const text = `${err.name}: ${err.message} ${(err.cause as Error | undefined)?.message ?? ""}`;
    if (/wake-hint stream (ended|idle timeout|parse failed)|fetch failed|TypeError:\s*terminated\b|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EPIPE|socket|network|UND_ERR/i.test(text)) {
      return "retryable";
    }
  }
  return "fatal";
}

const BRIDGE_RETRY_MAX_DELAY_MS = 60_000;

function bridgeRetryDelayMs(consecutiveFailures: number, pollIntervalMs: number): number {
  const exp = Math.min(consecutiveFailures - 1, 10);
  return Math.min(pollIntervalMs * 2 ** exp, BRIDGE_RETRY_MAX_DELAY_MS);
}

function parsePositiveInt(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CliError({
      code: "INVALID_ARG",
      message: `--${label} must be a positive integer`,
    });
  }
  return parsed;
}

function createWakeAdapter(options: BridgeOptions, env: NodeJS.ProcessEnv = process.env) {
  if (!options.wakeAdapter) return undefined;
  // `wake-channel` is the protocol's name (plugin 0.2.0 pure-break rename,
  // task #99): a localhost POST /wake with `x-raft-bridge-token` auth and a
  // content-free `raft-channel-wake.v1` payload, shared by every runtime
  // plugin (Claude Code, Hermes gateway, OpenClaw next).
  if (options.wakeAdapter !== "wake-channel") {
    throw new CliError({
      code: "INVALID_ARG",
      message: "--wake-adapter must be `wake-channel`",
    });
  }
  return createRaftChannelWakeAdapter({
    endpointUrl: options.wakeChannelEndpoint,
    token: options.wakeChannelToken ?? env.RAFT_CHANNEL_TOKEN,
  });
}

function createActivityDrainSource(
  options: BridgeOptions,
  env: NodeJS.ProcessEnv = process.env,
): AgentCommsActivityDrainSource | undefined {
  const endpointUrl = options.activityChannelEndpoint ?? deriveActivityDrainEndpoint(options.wakeChannelEndpoint);
  if (!endpointUrl) return undefined;
  const token = options.activityChannelToken ?? options.wakeChannelToken ?? env.RAFT_CHANNEL_TOKEN;
  return {
    async drainActivity(input) {
      const url = new URL(endpointUrl);
      url.searchParams.set("max", String(input.max));
      const signal = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(3000) : undefined;
      const response = await fetch(url, {
        method: "GET",
        signal,
        headers: {
          ...(token ? { "x-raft-bridge-token": token } : {}),
        },
      });
      const contentType = response.headers.get("content-type") ?? "";
      const data = contentType.includes("application/json") ? await response.json() : {};
      if (!response.ok) {
        throw new CliError({
          code: response.status >= 500 ? "SERVER_5XX" : "BRIDGE_ACTIVITY_DRAIN_FAILED",
          message: typeof data?.error === "string" ? data.error : `HTTP ${response.status}`,
        });
      }
      return data;
    },
  };
}

function createDaemonApiActivitySink(client: DaemonApiBridgeClient): AgentCommsActivitySink {
  return {
    async forwardActivity(input) {
      const response = await client.activity.forward(input as DaemonApiRequestBodyByRoute["activityForward"]);
      if (!response.ok) {
        throw new CliError({
          code: response.status >= 500 ? "SERVER_5XX" : "BRIDGE_ACTIVITY_FORWARD_FAILED",
          message: response.error ?? `HTTP ${response.status}`,
        });
      }
    },
  };
}

async function forwardBridgeFatalActivity(input: {
  sink: AgentCommsActivitySink;
  errorCode: string;
  message: string;
  emit: (value: unknown) => void;
}): Promise<void> {
  try {
    await input.sink.forwardActivity({
      schema: EXTERNAL_AGENT_ACTIVITY_INGEST_SCHEMA,
      events: [{
        schema: EXTERNAL_AGENT_ACTIVITY_EVENT_SCHEMA,
        eventId: `bridge_fatal_${randomUUID()}`,
        hookEventName: "BridgeFatal",
        status: "failed",
        occurredAt: new Date(currentTimeMs()).toISOString(),
        errorClass: input.errorCode,
        toolOutput: input.message,
        toolOutputTruncated: false,
      }],
    });
    input.emit({ type: "bridge_fatal_activity_forwarded" });
  } catch (err) {
    input.emit({
      type: "bridge_fatal_activity_forward_failed",
      errorCode: err instanceof CliError ? err.code : err instanceof Error ? err.name : "Error",
      message: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    });
  }
}

function deriveActivityDrainEndpoint(wakeChannelEndpoint?: string): string | undefined {
  if (!wakeChannelEndpoint) return undefined;
  try {
    const url = new URL(wakeChannelEndpoint);
    url.pathname = "/activity/drain";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
