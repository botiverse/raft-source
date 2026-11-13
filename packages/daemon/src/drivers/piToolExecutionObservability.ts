import { AsyncLocalStorage } from "node:async_hooks";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

import type { Tracer } from "@botiverse/raft-shared";
import type {
  RuntimeToolDiagnosticInput,
  RuntimeToolDiagnosticSnapshot,
} from "./types";

export const PI_TOOL_OBSERVATION_INTERVAL_MS = 15 * 60_000;
export const PI_TOOL_PROGRESS_COALESCE_MS = 60_000;

type PiToolProgressSource = "stdio" | "runtime_update";

/**
 * Who asked for the abort. Pi's `session.abort()` takes no reason and the tool's
 * signal belongs to Pi's run, so `signal.reason` is always the default
 * AbortError; the driver records the cause here before it aborts.
 */
export type PiToolAbortCause = "stop" | "interrupt";

/**
 * Why a failed or aborted execution ended, from typed observations only
 * (the abort cause, the command tool's own timeout, the process exit kind);
 * never from command text, output, or error messages.
 */
type PiToolFailureReason =
  | "timeout"
  | "killed_by_signal"
  | "aborted_by_stop"
  | "aborted_by_interrupt"
  | "spawn_failed"
  | "other";

type PiToolExecutionState = {
  runtimeToolCallId: string;
  runtimeToolCallIdPresent: boolean;
  runtimeTurnId: string;
  runtimeTurnIdentityPresent: boolean;
  toolExecutionInstanceId: string;
  startedAtMs: number;
  processCapability: "daemon_owned" | "not_applicable" | "unknown";
  process?: ChildProcess;
  processTreeTracking?: "root_only" | "process_group" | "job_object" | "unknown";
  processInstanceId?: string;
  processSpawnedAtMs?: number;
  processExitObservedAtMs?: number;
  processExitKind?: "code_zero" | "code_nonzero" | "signal" | "spawn_error" | "unknown";
  timeoutFired?: boolean;
  abortCause?: PiToolAbortCause;
  lastProgressAtMs?: number;
  progressBytesSinceEmit: number;
  progressUpdatesSinceEmit: number;
  progressSourcesSinceEmit: Set<PiToolProgressSource>;
  progressDirty: boolean;
  lastProgressEmitAtMs?: number;
};

export interface PiToolExecutionObserver {
  beginRuntimeTurn(): string;
  observeRuntimeTurnStart(): string;
  observeRuntimeTurnEnd(): void;
  setRuntimeSessionId(sessionId: string | null): void;
  runToolExecution<T>(
    runtimeToolCallId: string,
    signal: AbortSignal | undefined,
    invoke: () => Promise<T>,
  ): Promise<T>;
  observeRuntimeUpdate(runtimeToolCallId: string): void;
  observeProcessSpawned(
    child: ChildProcess,
    input: {
      processTreeTracking: "root_only" | "process_group" | "job_object" | "unknown";
      stdioMode: "pipe" | "ignore" | "inherit" | "mixed" | "unknown";
    },
  ): void;
  observeProcessProgress(bytes: number): void;
  observeProcessExit(input: {
    code: number | null;
    signal: NodeJS.Signals | null;
    spawnError?: boolean;
  }): void;
  /** The command tool's own timeout ended the command. */
  observeTimeout(): void;
  /** Call before aborting; marks the executions pending at that moment. */
  observeAbortRequested(cause: PiToolAbortCause): void;
  emitDiagnosticSnapshots(input: RuntimeToolDiagnosticInput): RuntimeToolDiagnosticSnapshot[];
}

type PiToolExecutionObserverOptions = {
  tracer?: Tracer;
  serverId: string;
  machineId: string;
  agentId: string;
  launchId: string;
  /** Runtime that owns the Pi session; built-in reuses Pi's command tool. */
  runtime?: "pi" | "builtin";
  runtimeVersion: string;
  runtimeSessionId?: string | null;
  now?: () => number;
  idGenerator?: () => string;
  probeChildLiveness?: (child: ChildProcess) => boolean | undefined;
  /** Whether any process is left in the child's process group (task #1302). */
  probeProcessGroupLiveness?: (child: ChildProcess) => boolean | undefined;
};

function nonNegativeMs(value: number): number {
  return Math.max(0, Math.floor(value));
}

function observedBytesBucket(bytes: number): "0" | "1-1k" | "1k-64k" | "64k-1m" | ">1m" | "unknown" {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  if (bytes === 0) return "0";
  if (bytes <= 1024) return "1-1k";
  if (bytes <= 64 * 1024) return "1k-64k";
  if (bytes <= 1024 * 1024) return "64k-1m";
  return ">1m";
}

function updateCountBucket(count: number): "1" | "2-10" | "11-100" | ">100" | "unknown" {
  if (!Number.isFinite(count) || count < 1) return "unknown";
  if (count === 1) return "1";
  if (count <= 10) return "2-10";
  if (count <= 100) return "11-100";
  return ">100";
}

function progressSource(
  sources: ReadonlySet<PiToolProgressSource>,
): "stdio" | "runtime_update" | "both" {
  return sources.size > 1
    ? "both"
    : sources.has("runtime_update")
      ? "runtime_update"
      : "stdio";
}

function failureReason(
  executionState: "failed" | "aborted",
  state: PiToolExecutionState,
): PiToolFailureReason {
  if (executionState === "aborted") {
    return state.abortCause === "stop"
      ? "aborted_by_stop"
      : state.abortCause === "interrupt"
        ? "aborted_by_interrupt"
        : "other";
  }
  if (state.timeoutFired) return "timeout";
  if (state.processExitKind === "spawn_error") return "spawn_failed";
  // Pi's bash tool resolves a non-zero exit code as an isError result, so it
  // finishes `succeeded` and only process.exited `exit_kind` carries it; a
  // throw after such an exit is some later step failing (saving output, …),
  // which is `other` like the same failure after exit 0. A signal death the
  // tool did not cause (the OOM killer) throws: Raft's operations return no
  // exit code for it.
  if (state.processExitKind === "signal") return "killed_by_signal";
  return "other";
}

function defaultProbeProcessGroupLiveness(child: ChildProcess): boolean | undefined {
  if (process.platform === "win32" || typeof child.pid !== "number") return undefined;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    return undefined;
  }
}

function defaultProbeChildLiveness(child: ChildProcess): boolean | undefined {
  if (child.exitCode !== null || child.signalCode !== null) return false;
  if (typeof child.pid !== "number") return undefined;
  try {
    process.kill(child.pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    return undefined;
  }
}

export class PiToolExecutionTraceObserver implements PiToolExecutionObserver {
  private readonly executionContext = new AsyncLocalStorage<PiToolExecutionState>();
  private readonly pendingExecutions = new Map<string, PiToolExecutionState>();
  private readonly runtimeToolCallExecutions = new Map<string, Set<string>>();
  private readonly now: () => number;
  private readonly idGenerator: () => string;
  private readonly probeChildLiveness: (child: ChildProcess) => boolean | undefined;
  private readonly probeProcessGroupLiveness: (child: ChildProcess) => boolean | undefined;
  private runtimeSessionId: string | null;
  private runtimeTurnId: string | null = null;
  private runtimeTurnIdentityPresent = false;

  constructor(private readonly options: PiToolExecutionObserverOptions) {
    this.now = options.now ?? Date.now;
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.probeChildLiveness = options.probeChildLiveness ?? defaultProbeChildLiveness;
    this.probeProcessGroupLiveness = options.probeProcessGroupLiveness ?? defaultProbeProcessGroupLiveness;
    this.runtimeSessionId = options.runtimeSessionId ?? null;
  }

  beginRuntimeTurn(): string {
    this.runtimeTurnId = this.idGenerator();
    this.runtimeTurnIdentityPresent = true;
    return this.runtimeTurnId;
  }

  observeRuntimeTurnStart(): string {
    return this.runtimeTurnId ?? this.beginRuntimeTurn();
  }

  observeRuntimeTurnEnd(): void {
    this.runtimeTurnId = null;
    this.runtimeTurnIdentityPresent = false;
  }

  setRuntimeSessionId(sessionId: string | null): void {
    this.runtimeSessionId = sessionId;
  }

  async runToolExecution<T>(
    runtimeToolCallId: string,
    signal: AbortSignal | undefined,
    invoke: () => Promise<T>,
  ): Promise<T> {
    const runtimeTurnIdentityPresent = this.runtimeTurnIdentityPresent && Boolean(this.runtimeTurnId);
    const state: PiToolExecutionState = {
      runtimeToolCallId,
      runtimeToolCallIdPresent: runtimeToolCallId.length > 0,
      runtimeTurnId: this.runtimeTurnId ?? this.idGenerator(),
      runtimeTurnIdentityPresent,
      toolExecutionInstanceId: this.idGenerator(),
      startedAtMs: this.now(),
      processCapability: "daemon_owned",
      progressBytesSinceEmit: 0,
      progressUpdatesSinceEmit: 0,
      progressSourcesSinceEmit: new Set(),
      progressDirty: false,
    };
    this.pendingExecutions.set(state.toolExecutionInstanceId, state);
    this.indexRuntimeToolCall(state);
    this.emitFact("daemon.runtime.tool.execution.started", state, {
      execution_state: "pending",
      process_capability: state.processCapability,
    });

    let executionState: "succeeded" | "failed" | "aborted" | "unknown" = "unknown";
    try {
      const result = await this.executionContext.run(state, invoke);
      executionState = signal?.aborted ? "aborted" : "succeeded";
      return result;
    } catch (error) {
      executionState = signal?.aborted ? "aborted" : "failed";
      throw error;
    } finally {
      this.flushProgress(state);
      this.emitFact("daemon.runtime.tool.execution.finished", state, {
        execution_state: executionState,
        ...(executionState === "failed" || executionState === "aborted"
          ? { failure_reason: failureReason(executionState, state) }
          : {}),
        execution_runtime_ms: nonNegativeMs(this.now() - state.startedAtMs),
        process_exit_observed_before_finish: state.processExitObservedAtMs !== undefined,
      });
      this.pendingExecutions.delete(state.toolExecutionInstanceId);
      this.unindexRuntimeToolCall(state);
    }
  }

  observeRuntimeUpdate(runtimeToolCallId: string): void {
    const executionIds = this.runtimeToolCallExecutions.get(runtimeToolCallId);
    if (executionIds?.size !== 1) return;
    const [toolExecutionInstanceId] = executionIds;
    const state = toolExecutionInstanceId
      ? this.pendingExecutions.get(toolExecutionInstanceId)
      : undefined;
    if (!state) return;
    this.observeProgress(state, "runtime_update", 0);
  }

  observeProcessSpawned(
    child: ChildProcess,
    input: {
      processTreeTracking: "root_only" | "process_group" | "job_object" | "unknown";
      stdioMode: "pipe" | "ignore" | "inherit" | "mixed" | "unknown";
    },
  ): void {
    const state = this.executionContext.getStore();
    if (!state || state.process) return;
    state.process = child;
    state.processTreeTracking = input.processTreeTracking;
    state.processInstanceId = this.idGenerator();
    state.processSpawnedAtMs = this.now();
    this.emitFact("daemon.runtime.tool.process.spawned", state, {
      process_state: "alive",
      process_tree_tracking: input.processTreeTracking,
      stdio_mode: input.stdioMode,
    });
  }

  observeProcessProgress(bytes: number): void {
    const state = this.executionContext.getStore();
    if (!state) return;
    this.observeProgress(state, "stdio", bytes);
  }

  observeProcessExit(input: {
    code: number | null;
    signal: NodeJS.Signals | null;
    spawnError?: boolean;
  }): void {
    const state = this.executionContext.getStore();
    if (!state || state.processExitObservedAtMs !== undefined) return;
    state.processExitObservedAtMs = this.now();
    state.processExitKind = input.spawnError
      ? "spawn_error"
      : input.signal
        ? "signal"
        : input.code === 0
          ? "code_zero"
          : typeof input.code === "number"
            ? "code_nonzero"
            : "unknown";
    this.emitFact("daemon.runtime.tool.process.exited", state, {
      process_state: "exited",
      exit_kind: state.processExitKind,
      process_runtime_ms: nonNegativeMs(
        state.processExitObservedAtMs - (state.processSpawnedAtMs ?? state.startedAtMs),
      ),
    });
  }

  observeTimeout(): void {
    const state = this.executionContext.getStore();
    if (state) state.timeoutFired = true;
  }

  observeAbortRequested(cause: PiToolAbortCause): void {
    for (const state of this.pendingExecutions.values()) {
      state.abortCause ??= cause;
    }
  }

  emitDiagnosticSnapshots(input: RuntimeToolDiagnosticInput): RuntimeToolDiagnosticSnapshot[] {
    const observationIntervalMs = Math.max(
      1,
      nonNegativeMs(input.observationIntervalMs ?? PI_TOOL_OBSERVATION_INTERVAL_MS),
    );
    const pending = [...this.pendingExecutions.values()];
    if (pending.length === 0) {
      const state = this.syntheticDiagnosticState();
      const snapshot: RuntimeToolDiagnosticSnapshot = {
        classification: "runtime_inactive_without_pending_tool",
        toolExecutionInstanceId: state.toolExecutionInstanceId,
        toolPending: false,
        processLiveness: "not_spawned",
        progressState: "unavailable",
        negativeEvidenceBucket: this.identityNegativeEvidence(state) ?? "none",
      };
      this.emitDiagnosticFact(state, input, observationIntervalMs, snapshot);
      return [snapshot];
    }

    return pending.map((state) => {
      this.flushProgress(state);
      const now = this.now();
      const snapshot: RuntimeToolDiagnosticSnapshot = {
        ...this.classifyPending(state, observationIntervalMs),
        ...(state.runtimeToolCallIdPresent ? { runtimeToolCallId: state.runtimeToolCallId } : {}),
        toolAgeMs: nonNegativeMs(now - state.startedAtMs),
        ...(state.lastProgressAtMs !== undefined
          ? { lastProgressAgeMs: nonNegativeMs(now - state.lastProgressAtMs) }
          : {}),
      };
      this.emitDiagnosticFact(state, input, observationIntervalMs, snapshot);
      return snapshot;
    });
  }

  private observeProgress(state: PiToolExecutionState, source: PiToolProgressSource, bytes: number): void {
    const now = this.now();
    state.lastProgressAtMs = now;
    state.progressDirty = true;
    state.progressSourcesSinceEmit.add(source);
    if (source === "stdio") {
      state.progressBytesSinceEmit += Math.max(0, Number.isFinite(bytes) ? Math.floor(bytes) : 0);
    } else {
      state.progressUpdatesSinceEmit += 1;
    }
    if (
      state.lastProgressEmitAtMs !== undefined
      && now - state.lastProgressEmitAtMs < PI_TOOL_PROGRESS_COALESCE_MS
    ) {
      return;
    }
    this.flushProgress(state);
  }

  private indexRuntimeToolCall(state: PiToolExecutionState): void {
    if (!state.runtimeToolCallIdPresent) return;
    const executionIds = this.runtimeToolCallExecutions.get(state.runtimeToolCallId) ?? new Set();
    executionIds.add(state.toolExecutionInstanceId);
    this.runtimeToolCallExecutions.set(state.runtimeToolCallId, executionIds);
  }

  private unindexRuntimeToolCall(state: PiToolExecutionState): void {
    if (!state.runtimeToolCallIdPresent) return;
    const executionIds = this.runtimeToolCallExecutions.get(state.runtimeToolCallId);
    if (!executionIds) return;
    executionIds.delete(state.toolExecutionInstanceId);
    if (executionIds.size === 0) this.runtimeToolCallExecutions.delete(state.runtimeToolCallId);
  }

  private flushProgress(state: PiToolExecutionState): void {
    if (!state.progressDirty || state.progressSourcesSinceEmit.size === 0) return;
    this.emitFact("daemon.runtime.tool.progress.observed", state, {
      progress_source: progressSource(state.progressSourcesSinceEmit),
      observed_bytes_bucket: observedBytesBucket(state.progressBytesSinceEmit),
      update_count_bucket: updateCountBucket(state.progressUpdatesSinceEmit),
    });
    state.progressDirty = false;
    state.progressBytesSinceEmit = 0;
    state.progressUpdatesSinceEmit = 0;
    state.progressSourcesSinceEmit.clear();
    state.lastProgressEmitAtMs = this.now();
  }

  private classifyPending(
    state: PiToolExecutionState,
    observationIntervalMs: number,
  ): RuntimeToolDiagnosticSnapshot {
    const identityNegativeEvidence = this.identityNegativeEvidence(state);
    if (state.processExitObservedAtMs !== undefined) {
      return {
        classification: "completion_loss",
        toolExecutionInstanceId: state.toolExecutionInstanceId,
        processInstanceId: state.processInstanceId,
        toolPending: true,
        processLiveness: "exited",
        processGroupLiveness: this.processGroupLiveness(state),
        progressState: this.progressState(state, observationIntervalMs),
        negativeEvidenceBucket: identityNegativeEvidence ?? "none",
      };
    }
    if (!state.process) {
      return {
        classification: "pending_liveness_unknown",
        toolExecutionInstanceId: state.toolExecutionInstanceId,
        toolPending: true,
        processLiveness: "not_spawned",
        progressState: this.progressState(state, observationIntervalMs),
        negativeEvidenceBucket: identityNegativeEvidence ?? "process_carrier_missing",
      };
    }

    const alive = this.probeChildLiveness(state.process);
    if (alive !== true) {
      return {
        classification: "pending_liveness_unknown",
        toolExecutionInstanceId: state.toolExecutionInstanceId,
        processInstanceId: state.processInstanceId,
        toolPending: true,
        processLiveness: "unavailable",
        progressState: this.progressState(state, observationIntervalMs),
        negativeEvidenceBucket: identityNegativeEvidence
          ?? (alive === false ? "producer_stale_or_unreachable" : "process_probe_unavailable"),
      };
    }

    const progressState = this.progressState(state, observationIntervalMs);
    return {
      classification: progressState === "recent"
        ? "running_with_recent_progress"
        : progressState === "stale" || progressState === "never_observed"
          ? "running_no_observed_progress"
          : "unknown",
      toolExecutionInstanceId: state.toolExecutionInstanceId,
      processInstanceId: state.processInstanceId,
      toolPending: true,
      processLiveness: "alive",
      progressState,
      negativeEvidenceBucket: identityNegativeEvidence
        ?? (progressState === "unavailable" ? "progress_not_observable" : "none"),
    };
  }

  private progressState(
    state: PiToolExecutionState,
    observationIntervalMs: number,
  ): RuntimeToolDiagnosticSnapshot["progressState"] {
    if (state.lastProgressAtMs === undefined) return "never_observed";
    return this.now() - state.lastProgressAtMs <= observationIntervalMs ? "recent" : "stale";
  }

  private identityNegativeEvidence(
    state: PiToolExecutionState,
  ): RuntimeToolDiagnosticSnapshot["negativeEvidenceBucket"] | null {
    if (!this.runtimeSessionId) return "runtime_session_identity_missing";
    if (!state.runtimeTurnIdentityPresent) return "turn_identity_missing";
    if (!state.toolExecutionInstanceId || (state.process && !state.processInstanceId)) return "join_key_missing";
    return null;
  }

  private syntheticDiagnosticState(): PiToolExecutionState {
    return {
      runtimeToolCallId: "",
      runtimeToolCallIdPresent: false,
      runtimeTurnId: this.runtimeTurnId ?? this.idGenerator(),
      runtimeTurnIdentityPresent: this.runtimeTurnIdentityPresent && Boolean(this.runtimeTurnId),
      toolExecutionInstanceId: this.idGenerator(),
      startedAtMs: this.now(),
      processCapability: "unknown",
      progressBytesSinceEmit: 0,
      progressUpdatesSinceEmit: 0,
      progressSourcesSinceEmit: new Set(),
      progressDirty: false,
    };
  }

  /**
   * The shell exiting does not end its work: a backgrounded descendant in the
   * same process group can still be running, and abort kills the whole group.
   * Only a process-group probe can say the group is gone.
   */
  private processGroupLiveness(state: PiToolExecutionState): "alive" | "exited" | "unknown" {
    if (state.processTreeTracking !== "process_group" || !state.process) return "unknown";
    const alive = this.probeProcessGroupLiveness(state.process);
    return alive === true ? "alive" : alive === false ? "exited" : "unknown";
  }

  private emitDiagnosticFact(
    state: PiToolExecutionState,
    input: RuntimeToolDiagnosticInput,
    observationIntervalMs: number,
    snapshot: RuntimeToolDiagnosticSnapshot,
  ): void {
    const processLivenessSource = snapshot.processLiveness === "alive"
      ? "child_handle_and_os_probe"
      : snapshot.processLiveness === "exited"
        ? "child_handle"
        : "none";
    this.emitFact("daemon.runtime.tool.diagnostic.snapshot", state, {
      diagnostic_trigger: input.trigger,
      classification: snapshot.classification,
      tool_pending: snapshot.toolPending,
      process_liveness: snapshot.processLiveness,
      process_liveness_source: processLivenessSource,
      ...(snapshot.processGroupLiveness !== undefined
        ? { process_group_liveness: snapshot.processGroupLiveness }
        : {}),
      progress_state: snapshot.progressState,
      ...(snapshot.toolAgeMs !== undefined ? { tool_age_ms: snapshot.toolAgeMs } : {}),
      ...(snapshot.lastProgressAgeMs !== undefined
        ? { last_progress_age_ms: snapshot.lastProgressAgeMs }
        : {}),
      observation_interval_ms: observationIntervalMs,
      runtime_inactivity_age_ms: nonNegativeMs(input.runtimeInactivityAgeMs),
      negative_evidence_bucket: snapshot.negativeEvidenceBucket,
    });
  }

  private emitFact(
    name:
      | "daemon.runtime.tool.execution.started"
      | "daemon.runtime.tool.process.spawned"
      | "daemon.runtime.tool.progress.observed"
      | "daemon.runtime.tool.process.exited"
      | "daemon.runtime.tool.execution.finished"
      | "daemon.runtime.tool.diagnostic.snapshot",
    state: PiToolExecutionState,
    attrs: Record<string, unknown>,
  ): void {
    this.options.tracer?.emitEvent(name, {
      surface: "daemon",
      attrs: {
        schema_version: "stuck_tool_v0",
        server_id: this.options.serverId,
        machine_id: this.options.machineId,
        agent_id: this.options.agentId,
        launch_id: this.options.launchId,
        runtime_session_id: this.runtimeSessionId || undefined,
        runtime_session_id_present: Boolean(this.runtimeSessionId),
        runtime_turn_id: state.runtimeTurnId,
        tool_execution_instance_id: state.toolExecutionInstanceId,
        runtime_tool_call_id_present: state.runtimeToolCallIdPresent,
        process_instance_id: state.processInstanceId,
        producer_fact_id: this.idGenerator(),
        runtime: this.options.runtime ?? "pi",
        runtime_version: this.options.runtimeVersion,
        tool_class: "bash",
        ...attrs,
        status: "ok",
      },
    });
  }
}

export function createPiToolExecutionObserver(
  options: PiToolExecutionObserverOptions,
): PiToolExecutionObserver {
  return new PiToolExecutionTraceObserver(options);
}
