import { existsSync } from "node:fs";
import path from "node:path";
import {
  AGENT_CONTEXT_VIEW_AVAILABILITY_TYPE,
  AGENT_CONTEXT_VIEW_DEFAULT_RETENTION_DAYS,
  AGENT_CONTEXT_VIEW_MAX_BYTES,
  AGENT_CONTEXT_VIEW_VIEWER_WAIT_MS,
  readAgentContextSearchRequest,
  readAgentContextViewRequest,
  type AgentContextSearchRequestMessage,
  type AgentContextViewAvailabilityMessage,
  type AgentContextViewRequestMessage,
} from "@botiverse/raft-shared";
import { contextViewRestoreFailure, type ContextViewRestored } from "./contextViewRestore";
import { CONTEXT_VIEW_RESTORE_TIMEOUT_MS, restoreContextViewInChild, type ContextViewRestorer } from "./contextViewRestoreRunner";
import { postContextViewResult, type ContextViewFetch } from "./contextViewResultPost";
import {
  contextViewSessionRecordsRequests,
  contextViewRelativeTranscript,
  contextViewSessionPath,
  contextViewSourceSize,
} from "./contextViewSource";
import {
  AGENT_CONTEXT_VIEW_OFF_GRACE_MS,
  appendContextViewIndexLine,
  clearContextViewOff,
  compactContextViewIndex,
  contextViewServerDir,
  findContextViewIndexLine,
  hasContextViewData,
  listContextViewAgents,
  markContextViewOff,
  readContextViewIndex,
  readContextViewOffSince,
  removeContextViewData,
  type ContextViewServerDir,
  agentContextDir,
  ensureContextViewRequestLogDir,
  PI_REQUEST_LOG_DIR_NAME,
} from "./contextViewStore";
import { isPiRequestLogRuntime, sweepPiRequestLogs } from "./piRequestLog";

/**
 * View Context v0, daemon side (Claude Code, Kimi, Pi, Built-in and Codex). Owns, per agent:
 *
 * - the gate: on only while the agent's effective config says
 *   `agentContextView: true` (the Server's `agent_context_view_v0` flag, from
 *   `agent:start` and every `server:features` answer); the daemon advertises
 *   `agent-context-view:v0` unconditionally. Off stops indexing and serving
 *   at once; the agent's data is removed only once the flag has been off for
 *   24 h without a break (`AGENT_CONTEXT_VIEW_OFF_GRACE_MS`), so one flag
 *   read that blips off loses nothing, and on again within that keeps it;
 * - the send index (contextViewStore.ts): one line per message send / task
 *   reply the Server accepted, naming the session file and its length then;
 *   kept per server (`<raftHome>/agent-context/<serverId>/<agentId>/`): a
 *   Raft Computer runs one daemon per attached server on one Raft home, so
 *   each daemon's flag, sweep, gate and index see only its own server's
 *   agents (an agent's data under its config's `runtimeContext.serverId`;
 *   the whole-server sweep and flag under the server this daemon is
 *   connected to, and not before it knows which). An agent without a server
 *   id is not indexed and reported as `no_session`;
 * - the availability report (`agent:context_view_availability`);
 * - the view request: index line -> session file -> restore
 *   (claudeSessionRestore.ts) -> redaction -> one result POST, never retried.
 *
 * Nothing here can fail a send or a start: every error is traced and dropped.
 */

/** What the daemon knows of one agent (from its live process or restart snapshot). */
export interface ContextViewAgentFacts {
  /** Raft runtime id; null when the daemon holds no config for the agent. */
  runtime: string | null;
  /** The server the agent's config is for (`runtimeContext.serverId`); null when unknown. Its data lives under this server. */
  serverId: string | null;
  sessionId: string | null;
  running: boolean;
  /** Where the runtime keeps its session files (Claude: `<home>/.claude/projects`; kimi-sdk: its SDK home); null for other runtimes. */
  sessionRoot: string | null;
  /** The roots a session file must be inside (allowedTranscriptRootsForRuntime). */
  allowedRoots: readonly string[];
  /** The current session's file, looked up on demand (a directory walk); null when there is none. */
  resolveSessionFile(): string | null;
}

export type ContextViewTraceRecorder = (name: string, attrs: Record<string, unknown>, status?: "ok" | "error") => void;

export interface AgentContextViewServiceOptions {
  raftHome: string;
  /**
   * The server this daemon is connected to; null until it knows. Whole-server
   * disk work (the sweep, the agents a server answer reaches by their data)
   * uses only this server's directory, and none until it is known.
   */
  connectedServerId(): string | null;
  serverUrl: string;
  apiKey: string;
  fetchImpl: ContextViewFetch;
  sendToServer(frame: AgentContextViewAvailabilityMessage): void;
  agentFacts(agentId: string): ContextViewAgentFacts;
  runningAgentIds(): string[];
  recordTrace: ContextViewTraceRecorder;
  /** Reads and restores one session file. By default in a child process of this binary (tests inject one). */
  restore?: ContextViewRestorer;
  now?: () => number;
  retentionDays?: number;
  /** Retention and off-grace sweep period; 0 disables the timer (tests call `sweep`). */
  sweepIntervalMs?: number;
  /** Timers (tests inject a fake); default: unref'd global timers that never keep the daemon alive. */
  timers?: ContextViewTimers;
  /** In [0, 1): picks the availability refresh jitter. */
  random?: () => number;
}

export interface ContextViewTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const DEFAULT_TIMERS: ContextViewTimers = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * The Server keeps an agent's availability report for 7 days, so every
 * running agent's is sent again at least this often: after a uniform
 * 20..24 h, so Computers that started together do not report together.
 */
export const AGENT_CONTEXT_VIEW_AVAILABILITY_REFRESH_MAX_MS = 24 * 60 * 60 * 1000;
const AVAILABILITY_REFRESH_JITTER_MS = 4 * 60 * 60 * 1000;

/** The runtimes this daemon can restore a context view for. */
export const CONTEXT_VIEW_SUPPORTED_RUNTIMES: readonly string[] = ["claude", "kimi-sdk", "pi", "builtin", "codex"];

const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** On a write, the index is compacted at most this often (the sweep does it hourly too). */
const COMPACT_ON_WRITE_INTERVAL_MS = 60 * 60 * 1000;

const failure = contextViewRestoreFailure;

/** Of the viewer's wait: room left for the result's POST. */
const RESTORE_POST_ROOM_MS = 5_000;
/** The shortest restore worth starting: a child alone takes most of a second to start, more on a small machine. */
const RESTORE_MIN_RUN_MS = 2_000;
/** A request queued past this is skipped: the answer would come after the viewer stopped waiting. */
const CONTEXT_VIEW_RESTORE_LATEST_START_MS = AGENT_CONTEXT_VIEW_VIEWER_WAIT_MS - RESTORE_POST_ROOM_MS - RESTORE_MIN_RUN_MS;

function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

export class AgentContextViewService {
  private readonly now: () => number;
  private readonly retentionDays: number;
  /** The flag as last seen per agent; absent: not seen since this daemon started. */
  private readonly flags = new Map<string, boolean>();
  private readonly lastReported = new Map<string, string>();
  private readonly lastCompactedAt = new Map<string, number>();
  private readonly sessionFiles = new Map<string, { sessionId: string; file: string }>();
  private readonly timers: ContextViewTimers;
  private readonly random: () => number;
  private sweepTimer: unknown = null;
  /** The first sweep (an off grace may have run out while the daemon was down) has run with a known server. */
  private startupSweepDone = false;
  private startupSweepQueued = false;
  /** Server ids already traced as not a path segment (traced once each). */
  private readonly rejectedServerIds = new Set<string>();
  private refreshTimer: unknown = null;
  /**
   * One restore at a time per daemon process: each is a child process that
   * holds a whole session file. A Computer runs one daemon per attached server,
   * so a machine's worst case is that many at once.
   */
  private requestChain: Promise<void> = Promise.resolve();
  private readonly restoreAbort = new AbortController();

  constructor(private readonly options: AgentContextViewServiceOptions) {
    this.now = options.now ?? Date.now;
    this.retentionDays = options.retentionDays ?? AGENT_CONTEXT_VIEW_DEFAULT_RETENTION_DAYS;
    this.timers = options.timers ?? DEFAULT_TIMERS;
    this.random = options.random ?? Math.random;
  }

  /**
   * Whether the agent's context view is on. Not seen since this daemon
   * started: the last state it left on disk (data and no off marker).
   */
  isEnabled(agentId: string): boolean {
    const seen = this.flags.get(agentId);
    if (seen !== undefined) return seen;
    try {
      const dir = this.agentServerDir(agentId);
      return dir !== null && hasContextViewData(dir, agentId) && readContextViewOffSince(dir, agentId) === null;
    } catch {
      return false;
    }
  }

  /** The agent's own server's data directory (its config's server id); null when it has none (or not a valid one). */
  private agentServerDir(agentId: string, facts: ContextViewAgentFacts = this.options.agentFacts(agentId)): ContextViewServerDir | null {
    return this.serverDir(facts.serverId, "agent");
  }

  /** The connected server's data directory; null until the daemon knows its server (or it is not a valid one). */
  private connectedServerDir(): ContextViewServerDir | null {
    return this.serverDir(this.options.connectedServerId(), "daemon");
  }

  private serverDir(serverId: string | null, source: "agent" | "daemon"): ContextViewServerDir | null {
    if (!serverId) return null;
    const dir = contextViewServerDir(this.options.raftHome, serverId);
    if (dir === null && !this.rejectedServerIds.has(serverId)) {
      this.rejectedServerIds.add(serverId);
      this.trace("daemon.agent_context_view.server_id_rejected", { source, length: serverId.length }, "error");
    }
    return dir;
  }

  /**
   * The agent's effective `agentContextView` (an `agent:start` config or a
   * `server:features` answer). Off marks its data for removal in 24 h; on
   * clears that mark. A running agent the gate just turned on for is reported.
   */
  observeFlag(agentId: string, enabled: boolean, trigger: "start" | "server_features"): void {
    this.observeFlagIn(agentId, enabled, trigger, this.agentServerDir(agentId));
  }

  /** `dir`: where the agent's data is (its own server's directory); null: it has none to mark. */
  private observeFlagIn(agentId: string, enabled: boolean, trigger: "start" | "server_features", dir: ContextViewServerDir | null): void {
    const was = this.isEnabled(agentId);
    this.flags.set(agentId, enabled);
    try {
      if (dir !== null) {
        if (enabled) clearContextViewOff(dir, agentId);
        else markContextViewOff(dir, agentId, this.now());
      }
    } catch (error) {
      this.trace("daemon.agent_context_view.gate_write_failed", { agentId, enabled, error_class: errorClass(error) }, "error");
    }
    this.ensureTimers();
    if (was === enabled) return;
    this.trace("daemon.agent_context_view.gate", { agentId, enabled, trigger });
    if (!enabled) {
      this.lastReported.delete(agentId);
      return;
    }
    if (trigger === "server_features" && this.options.agentFacts(agentId).running) void this.reportAvailability(agentId, "gate_on");
  }

  /**
   * A `server:features` answer: the flag for every agent this daemon holds,
   * and for every agent with data under this server's directory. Never
   * another server's agents (their daemon hears their own server's flag);
   * none known by their data until the daemon knows its server.
   */
  applyServerFlag(enabled: boolean, agentIds: Iterable<string>): void {
    const targets = new Map<string, ContextViewServerDir | null>();
    for (const agentId of agentIds) targets.set(agentId, this.agentServerDir(agentId));
    const ownDir = this.connectedServerDir();
    if (ownDir !== null) {
      try {
        for (const agentId of listContextViewAgents(ownDir)) {
          if (!targets.has(agentId)) targets.set(agentId, ownDir);
        }
      } catch {
        // no data directory: only the agents held
      }
    }
    for (const [agentId, dir] of targets) this.observeFlagIn(agentId, enabled, "server_features", dir);
  }

  /** An agent (re)started with this config flag: observe it and report availability. */
  onAgentStart(agentId: string, enabled: boolean): void {
    this.observeFlag(agentId, enabled, "start");
    if (enabled) void this.reportAvailability(agentId, "start", true);
  }

  /** After every `ready` (a new connection): report every running agent again. */
  reportAllRunning(trigger: string): void {
    // A ready may be the first moment the daemon knows its server: the startup sweep waits for it.
    if (this.sweepTimer !== null) this.queueStartupSweep();
    this.lastReported.clear();
    for (const agentId of this.options.runningAgentIds()) {
      if (this.isEnabled(agentId)) void this.reportAvailability(agentId, trigger, true);
    }
  }

  // -------------------------------------------------------------------------
  // Send index

  /**
   * The Server accepted a message send or task reply the agent made
   * (credential proxy, 2xx with a message id). Never throws and never waits:
   * the send's response does not depend on the index.
   */
  onMessageCommitted(agentId: string, messageId: string, route: "send" | "task_reply"): void {
    if (this.flags.get(agentId) !== true) return;
    void this.indexSend(agentId, messageId, route).catch((error: unknown) => {
      this.trace("daemon.agent_context_view.index", { agentId, route, outcome: "write_failed", error_class: errorClass(error) }, "error");
    });
  }

  private currentSessionFile(agentId: string, facts: ContextViewAgentFacts): string | null {
    if (!facts.sessionId) return null;
    const cached = this.sessionFiles.get(agentId);
    // A runtime can move its file: Codex decompresses an old rollout when it resumes one.
    if (cached && cached.sessionId === facts.sessionId && existsSync(cached.file)) return cached.file;
    const file = facts.resolveSessionFile();
    if (file) this.sessionFiles.set(agentId, { sessionId: facts.sessionId, file });
    return file;
  }

  private async indexSend(agentId: string, messageId: string, route: "send" | "task_reply"): Promise<void> {
    const facts = this.options.agentFacts(agentId);
    const runtime = facts.runtime;
    if (!runtime || !CONTEXT_VIEW_SUPPORTED_RUNTIMES.includes(runtime)) {
      this.trace("daemon.agent_context_view.index", { agentId, route, runtime: runtime ?? "unknown", outcome: "unsupported_runtime" });
      return;
    }
    const dir = this.agentServerDir(agentId, facts);
    if (dir === null) {
      this.trace("daemon.agent_context_view.index", { agentId, route, runtime, outcome: "no_server" });
      return;
    }
    const file = this.currentSessionFile(agentId, facts);
    const transcript = file && facts.sessionRoot ? contextViewRelativeTranscript(facts.sessionRoot, file) : null;
    const offset = file ? await contextViewSourceSize(file) : null;
    if (!facts.sessionId || !file || !transcript || offset === null) {
      this.trace("daemon.agent_context_view.index", { agentId, route, runtime, outcome: "no_session" });
      return;
    }
    const hadData = readContextViewIndex(dir, agentId).length > 0;
    appendContextViewIndexLine(dir, agentId, {
      messageId,
      sentAt: new Date(this.now()).toISOString(),
      runtime,
      sessionId: facts.sessionId,
      transcript,
      offset,
    });
    this.trace("daemon.agent_context_view.index", { agentId, route, runtime, outcome: "indexed" });
    const lastCompacted = this.lastCompactedAt.get(agentId);
    if (lastCompacted === undefined || this.now() - lastCompacted >= COMPACT_ON_WRITE_INTERVAL_MS) this.compact(dir, agentId);
    // The first retained request changes `retainedSince` (and may make the agent supported).
    if (!hadData) await this.reportAvailability(agentId, "first_index");
  }

  private compact(dir: ContextViewServerDir, agentId: string): { dropped: number } {
    this.lastCompactedAt.set(agentId, this.now());
    const cutoff = this.now() - this.retentionDays * 24 * 60 * 60 * 1000;
    const result = compactContextViewIndex(dir, agentId, cutoff);
    const logsRemoved = sweepPiRequestLogs(path.join(agentContextDir(dir, agentId), PI_REQUEST_LOG_DIR_NAME), cutoff);
    if (logsRemoved > 0) this.trace("daemon.agent_context_view.request_logs_removed", { agentId, removed_count: logsRemoved });
    if (result.dropped > 0) {
      this.trace("daemon.agent_context_view.retention", { agentId, dropped_count: result.dropped, kept_count: result.kept });
    }
    return { dropped: result.dropped };
  }

  /**
   * Retention and the off grace, for every agent with data under this
   * daemon's server (never another server's: their flag is not ours to
   * read): remove an agent's data once it has been off for 24 h, else drop
   * index lines older than the retention (and report the agents whose
   * `retainedSince` moved). Nothing until the daemon knows its server.
   */
  sweep(): void {
    const dir = this.connectedServerDir();
    if (dir === null) return;
    this.startupSweepDone = true;
    let agentIds: string[];
    try {
      agentIds = listContextViewAgents(dir);
    } catch {
      return;
    }
    for (const agentId of agentIds) {
      try {
        const offSince = readContextViewOffSince(dir, agentId);
        if (offSince !== null && this.flags.get(agentId) !== true) {
          if (this.now() - offSince >= AGENT_CONTEXT_VIEW_OFF_GRACE_MS) {
            removeContextViewData(dir, agentId);
            this.sessionFiles.delete(agentId);
            this.lastCompactedAt.delete(agentId);
            this.trace("daemon.agent_context_view.data_removed", { agentId, off_ms: this.now() - offSince });
          }
          continue;
        }
        const { dropped } = this.compact(dir, agentId);
        if (dropped > 0 && this.isEnabled(agentId) && this.options.agentFacts(agentId).running) {
          void this.reportAvailability(agentId, "retention");
        }
      } catch (error) {
        this.trace("daemon.agent_context_view.sweep_failed", { agentId, error_class: errorClass(error) }, "error");
      }
    }
  }

  /** The directory of this agent's request logs, for reading: nothing is created. */
  requestLogRoot(agentId: string, serverId: string | null): string | null {
    const dir = this.serverDir(serverId, "agent");
    return dir === null ? null : path.join(agentContextDir(dir, agentId), PI_REQUEST_LOG_DIR_NAME);
  }

  /**
   * Where a runtime hosted in this daemon records this agent's model requests;
   * null while the feature is off for the agent, which stops the writing.
   */
  requestLogDir(agentId: string): string | null {
    if (!this.isEnabled(agentId)) return null;
    const dir = this.serverDir(this.options.agentFacts(agentId).serverId, "agent");
    return dir === null ? null : ensureContextViewRequestLogDir(dir, agentId);
  }

  /** Started at the first flag seen (so a daemon that never hears of the feature runs nothing); stopped by `dispose`. */
  private ensureTimers(): void {
    if (this.disposed) return;
    const interval = this.options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    if (this.sweepTimer === null && interval > 0) this.scheduleSweep(interval);
    // Once at the start too: an off grace may have run out while the daemon was down.
    if (interval > 0) this.queueStartupSweep();
    if (this.refreshTimer === null) this.scheduleAvailabilityRefresh();
  }

  /** The startup sweep, once the daemon knows its server (else retried at the next flag or ready). */
  private queueStartupSweep(): void {
    if (this.disposed || this.startupSweepDone || this.startupSweepQueued) return;
    if (this.connectedServerDir() === null) return;
    this.startupSweepQueued = true;
    queueMicrotask(() => {
      this.startupSweepQueued = false;
      if (!this.disposed && !this.startupSweepDone) this.sweep();
    });
  }

  private scheduleSweep(interval: number): void {
    this.sweepTimer = this.timers.setTimeout(() => {
      this.sweepTimer = null;
      if (this.disposed) return;
      this.sweep();
      this.scheduleSweep(interval);
    }, interval);
  }

  /** The delay before the next periodic availability resend: uniform in [24 h - 4 h, 24 h). */
  availabilityRefreshDelayMs(): number {
    const jitter = Math.min(0.999999, Math.max(0, this.random())) * AVAILABILITY_REFRESH_JITTER_MS;
    return Math.floor(AGENT_CONTEXT_VIEW_AVAILABILITY_REFRESH_MAX_MS - AVAILABILITY_REFRESH_JITTER_MS + jitter);
  }

  private scheduleAvailabilityRefresh(): void {
    this.refreshTimer = this.timers.setTimeout(() => {
      this.refreshTimer = null;
      if (this.disposed) return;
      this.reportAllRunning("periodic");
      this.scheduleAvailabilityRefresh();
    }, this.availabilityRefreshDelayMs());
  }

  private disposed = false;

  /** Shutdown: no timer left running. */
  dispose(): void {
    this.restoreAbort.abort();
    this.disposed = true;
    if (this.sweepTimer !== null) this.timers.clearTimeout(this.sweepTimer);
    if (this.refreshTimer !== null) this.timers.clearTimeout(this.refreshTimer);
    this.sweepTimer = null;
    this.refreshTimer = null;
  }

  // -------------------------------------------------------------------------
  // Availability

  async availability(agentId: string): Promise<AgentContextViewAvailabilityMessage | null> {
    const facts = this.options.agentFacts(agentId);
    if (!facts.runtime) return null;
    const dir = this.agentServerDir(agentId, facts);
    const lines = dir === null ? [] : readContextViewIndex(dir, agentId);
    const oldest = lines.reduce<string | null>((min, line) => (min === null || Date.parse(line.sentAt) < Date.parse(min) ? line.sentAt : min), null);
    const base = {
      type: AGENT_CONTEXT_VIEW_AVAILABILITY_TYPE,
      agentId,
      runtime: facts.runtime,
      retainedSince: oldest === null ? null : new Date(Date.parse(oldest)).toISOString(),
      retentionDays: this.retentionDays,
    } as const;
    if (!CONTEXT_VIEW_SUPPORTED_RUNTIMES.includes(facts.runtime)) {
      return { ...base, supported: false, unsupportedReason: "unsupported_runtime" };
    }
    // Without a server there is nowhere to keep its index: nothing to show.
    if (dir === null) return { ...base, supported: false, unsupportedReason: "no_session" };
    // Supported once the runtime records its requests (Claude Code 2.1.30x)
    // or something is already retained; otherwise nothing to show yet.
    const file = this.currentSessionFile(agentId, facts);
    const recordsRequests = file ? await contextViewSessionRecordsRequests(facts.runtime, file) : false;
    return recordsRequests || lines.length > 0
      ? { ...base, supported: true }
      : { ...base, supported: false, unsupportedReason: "no_session" };
  }

  /** Send the agent's availability when the gate is on and it changed (or `force`). */
  async reportAvailability(agentId: string, trigger: string, force = false): Promise<void> {
    try {
      if (!this.isEnabled(agentId)) return;
      const report = await this.availability(agentId);
      if (!report || !this.isEnabled(agentId)) return;
      const key = JSON.stringify(report);
      if (!force && this.lastReported.get(agentId) === key) return;
      this.lastReported.set(agentId, key);
      this.options.sendToServer(report);
      this.trace("daemon.agent_context_view.availability", {
        agentId,
        runtime: report.runtime,
        supported: report.supported,
        unsupported_reason: report.unsupportedReason ?? null,
        retained: report.retainedSince !== null,
        trigger,
      });
    } catch (error) {
      this.trace("daemon.agent_context_view.availability_failed", { agentId, trigger, error_class: errorClass(error) }, "error");
    }
  }

  // -------------------------------------------------------------------------
  // View request

  /**
   * `agent:context_view_request`: ends in at most one result POST. Only a
   * trace when the frame is not a request, or when it waited in the queue
   * past the viewer's wait: the server has already answered the viewer
   * `expired`, so restoring would only cost memory.
   */
  handleRequest(frame: unknown): Promise<void> {
    const receivedAt = this.now();
    const run = this.requestChain.then(() => this.answer(frame, receivedAt));
    this.requestChain = run.catch(() => undefined);
    return run;
  }

  private async answer(frame: unknown, receivedAt: number): Promise<void> {
    const request = readAgentContextViewRequest(frame) ?? readAgentContextSearchRequest(frame);
    if (!request) {
      this.trace("daemon.agent_context_view.request_invalid", {}, "error");
      return;
    }
    const startedAt = this.now();
    // Stopping: a child would only be killed, and nobody reads the answer's POST here.
    if (this.restoreAbort.signal.aborted) return;
    if (startedAt - receivedAt >= CONTEXT_VIEW_RESTORE_LATEST_START_MS) {
      this.trace("daemon.agent_context_view.request_expired", { agentId: request.agentId, queued_ms: startedAt - receivedAt }, "error");
      return;
    }
    let resolved: ContextViewRestored;
    try {
      resolved = await this.resolve(request, receivedAt);
    } catch (error) {
      resolved = failure("read_failed", "exception", { error_class: errorClass(error) });
    }
    const restoreMs = this.now() - startedAt;
    const { json, outcome } = resolved;
    const post = await postContextViewResult({
      serverUrl: this.options.serverUrl,
      apiKey: this.options.apiKey,
      requestId: request.requestId,
      json,
      fetchImpl: this.options.fetchImpl,
    });
    this.trace("daemon.agent_context_view.request", {
      agentId: request.agentId,
      // Never the query text: an agent's search term stays out of traces.
      mode: "query" in request ? request.query.kind : "view",
      ...resolved.attrs,
      outcome,
      posted_bytes: Buffer.byteLength(json, "utf8"),
      compressed_bytes: post.compressedBytes,
      post_outcome: post.outcome,
      ...(post.outcome === "failed" ? { error_class: post.errorClass } : { http_status: post.status }),
      restore_ms: restoreMs,
      duration_ms: this.now() - startedAt,
    }, post.outcome === "accepted" ? "ok" : "error");
  }

  private async resolve(request: AgentContextViewRequestMessage | AgentContextSearchRequestMessage, receivedAt: number): Promise<ContextViewRestored> {
    const { agentId, messageId } = request;
    if (!this.isEnabled(agentId)) return failure("not_found", "gate_off");
    const facts = this.options.agentFacts(agentId);
    // The boundary between servers on a shared Computer: this daemon's key
    // uploads only its own server's agents, so a request for an agent of
    // another server (or before the connected server is known) is not_found.
    const connected = this.options.connectedServerId();
    if (!connected || facts.serverId !== connected) {
      return failure("not_found", "other_server", { runtime: facts.runtime ?? "unknown" });
    }
    const dir = this.agentServerDir(agentId, facts);
    if (dir === null) return failure("not_found", "no_server", { runtime: facts.runtime ?? "unknown" });
    const line = findContextViewIndexLine(dir, agentId, messageId);
    const runtime = facts.runtime ?? line?.runtime ?? null;
    if (!runtime) return failure("not_found", "unknown_agent");
    if (!CONTEXT_VIEW_SUPPORTED_RUNTIMES.includes(runtime)) return failure("unsupported_runtime", "runtime", { runtime });
    if (!facts.sessionRoot) return failure("not_found", "no_session_root", { runtime });

    // The log has no record of who sent what: only the index can place a message in it.
    if (!line && isPiRequestLogRuntime(runtime)) return failure("not_found", "no_index_line", { runtime });

    let file: string | null;
    let offset: number | null = null;
    let sessionId: string;
    const source = line ? "index" : "fallback";
    if (line) {
      file = contextViewSessionPath(facts.sessionRoot, line.transcript);
      if (!file) return failure("read_failed", "path_rejected", { runtime, source });
      offset = line.offset;
      sessionId = line.sessionId;
    } else {
      // A message sent before this daemon indexed sends: look for it in the
      // current session, where the CLI's output names it.
      file = this.currentSessionFile(agentId, facts);
      if (!file || !facts.sessionId) return failure("not_found", "no_index_line", { runtime, source });
      sessionId = facts.sessionId;
    }
    const restored = await (this.options.restore ?? restoreContextViewInChild)({
      runtime,
      file,
      allowedRoots: facts.allowedRoots,
      offset,
      messageId,
      sessionId,
      maxBytes: Math.min(request.maxBytes, AGENT_CONTEXT_VIEW_MAX_BYTES),
      ...("query" in request ? { query: request.query } : {}),
    }, {
      // A request that waited in the queue has less of the viewer's wait left.
      timeoutMs: Math.min(CONTEXT_VIEW_RESTORE_TIMEOUT_MS, AGENT_CONTEXT_VIEW_VIEWER_WAIT_MS - RESTORE_POST_ROOM_MS - (this.now() - receivedAt)),
      signal: this.restoreAbort.signal,
    });
    return { ...restored, attrs: { runtime, source, ...restored.attrs } };
  }

  private trace(name: string, attrs: Record<string, unknown>, status: "ok" | "error" = "ok"): void {
    try {
      this.options.recordTrace(name, attrs, status);
    } catch {
      // tracing never breaks the feature
    }
  }
}
