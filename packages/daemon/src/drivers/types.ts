import type { ChildProcess } from "node:child_process";
import type { ActiveSpan, AgentConfig, AgentMessage, RuntimeModelSourceOutcome, SubagentLineage, Tracer, AxSurfaceText } from "@botiverse/raft-shared";
import type { AgentProxyInboxCoordinator } from "../agentCredentialProxy.js";
import type { AgentAppInboxStore } from "../agentAppInbox.js";

// ── Runtime Contracts ──
// Behavior-level contracts that describe how the daemon should interact with a
// runtime. The legacy booleans below remain during the transition, but new
// drivers should make these policies explicit instead of encoding them as
// unrelated flags.

export type RuntimeLifecycleContract =
  | {
      kind: "persistent";
      stdin: "direct" | "notification";
      inFlightWake: "queue" | "steer";
    }
  | {
      kind: "per_turn";
      start: "immediate" | "defer_until_concrete_message";
      exit: "natural" | "terminate_on_turn_end";
      inFlightWake: "spawn_new" | "coalesce_into_pending";
    };

export type RuntimeCommunicationContract = {
  chat: "slock_cli";
  runtimeControl: "none";
};

export type RuntimeSessionContract = {
  /**
   * `resume_or_fresh` is the current built-in default: try native resume, then
   * cold-start if the native session is missing. `fresh` is reserved for future
   * explicitly ephemeral runtimes or no-resume modes.
   */
  recovery: "fresh" | "resume_or_fresh";
};

export type RuntimeModelVerification = "launchable" | "suggestion_only";
export type RuntimeStartupReadiness = "first_event" | "initial_turn";
export type RuntimeBusyDeliveryReadiness =
  | { ready: true }
  | {
      ready: false;
      reason: "no_active_turn";
    };

export interface RuntimeTurnAttribution {
  /**
   * Driver-owned generation identity. This is intentionally opaque to the APM:
   * the driver alone decides whether an output belongs to a live or terminal
   * runtime turn.
   */
  generation: number;
  state: "active" | "completed";
}

export interface RuntimeModelLaunchSpec {
  args?: string[];
  env?: Record<string, string>;
  configFiles?: string[];
  params?: Record<string, unknown>;
  config?: Record<string, unknown>;
}

export interface RuntimeModelContract {
  detectedModelsVerifiedAs: RuntimeModelVerification;
  /**
   * Derive the launch-time model surface from the same source used by spawn().
   * Drivers that need local provider config should accept a SpawnContext and
   * optional test/runtime overrides instead of re-encoding a parallel launch
   * path.
   */
  toLaunchSpec?(
    modelId: string,
    ctx?: SpawnContext,
    opts?: { home?: string },
  ): RuntimeModelLaunchSpec | Promise<RuntimeModelLaunchSpec>;
}

// ── Parsed Events ──
// Runtime events consumed by agentProcessManager. Telemetry is a sidecar:
// it must not refresh turn progress, clear startup state, or drive activity.
// Internal progress is a payload-free runtime liveness signal: it refreshes the
// progress clock but must not be rendered into the agent trajectory.
// Runtime diagnostics are non-terminal provider/runtime notices that should be
// visible without driving error state or satisfying initial-turn readiness.
// Delivery errors are asynchronous runtime rejections of daemon-originated
// follow-up delivery requests. They preserve local notification debt instead of
// becoming terminal/runtime errors.
// Runtime recovery notices are visible recovery facts: they explain daemon-side
// fallback without refreshing progress or satisfying initial-turn readiness.

export type ParsedEvent =
  | { kind: "session_init"; sessionId: string }
  | ({ kind: "thinking"; text: string; runtimeTurn?: RuntimeTurnAttribution } & SubagentLineage)
  | ({ kind: "text"; text: string; runtimeTurn?: RuntimeTurnAttribution } & SubagentLineage)
  | ({ kind: "tool_call"; name: string; input: any } & SubagentLineage)
  | ({ kind: "tool_output"; name: string } & SubagentLineage)
  | { kind: "compaction_started" }
  | { kind: "compaction_finished" }
  | {
      kind: "compaction_interrupted";
      outcome: "compaction_failed_or_exhausted" | "aborted";
      reason: "manual" | "threshold" | "overflow" | "unknown";
      failureReason?: "recovery_exhausted" | "compaction_failed";
    }
  | { kind: "review_started" }
  | { kind: "review_finished" }
  | { kind: "turn_end"; sessionId?: string }
  | {
      kind: "error";
      message: string;
      /**
       * Whether a native runtime reason field was present. Absence means the
       * driver contract cannot answer; false is explicit negative evidence.
       */
      nativeReasonPresent?: boolean;
      reasonProvenance?: "runtime_error_event" | "codex_native_reason" | "daemon_fallback";
      terminalReason?: "compaction_failed_or_exhausted";
      startupRequestMethod?:
        | "initialize"
        | "thread/start"
        | "thread/resume"
        | "turn/start"
        | "session/new"
        | "session/load"
        | "session/set_model"
        | "session/prompt";
    }
  | {
      kind: "delivery_error";
      message: string;
      requestMethod: "turn/start" | "turn/steer";
      source: "codex_app_server_response" | "grok_acp_response" | "kimi_sdk_response" | "pi_sdk_response";
      code?: "turn.agent_busy" | "runtime.delivery_error";
      payloadBytes?: number;
    }
  | {
      kind: "internal_progress";
      source:
        | "codex_raw_response_item"
        | "codex_app_server_notification"
        | "claude_stream_event"
        | "claude_system_status"
        | "grok_acp_notification";
      itemType?: string;
      payloadBytes?: number;
    }
  // A subagent (Claude `Agent` tool) lifecycle/activity signal derived from
  // EXPLICIT parent_tool_use_id / `system` task-lifecycle lineage — never
  // inferred from display text (APM 1.6 6b). Unlike internal_progress, this is
  // rendered into the trajectory as a subagent-marked activity. Carries only
  // closed ids / bounded tokens (Q8 discipline): no raw prompt or output.
  | {
      kind: "subagent_progress";
      source: "claude_task_lifecycle" | "claude_parent_tool_use";
      /** Bounded lifecycle phase from the `system` envelope kind. */
      phase: "started" | "progress" | "notification" | "active";
      /** Outer `Agent` tool_use id that owns this subagent turn. */
      parentToolUseId?: string;
      /** Declared subagent role (bounded label, never content). */
      subagentType?: string;
      /** Claude `system` task-lifecycle envelope id. */
      taskId?: string;
      /** Bounded tool name from the envelope's `last_tool_name`, if present. */
      lastToolName?: string;
      payloadBytes?: number;
    }
  | {
      kind: "runtime_diagnostic";
      severity: "warning";
      source: "codex_app_server_notification" | "grok_acp_notification";
      itemType: string;
      message: string;
      details?: string;
      path?: string;
      range?: unknown;
      payloadBytes?: number;
      sessionId?: string;
      inputEvidence?: "nonempty" | "unknown";
      reasonPresent?: boolean;
    }
  | {
      kind: "runtime_recovery";
      source: "codex_resume_missing_rollout" | "codex_resume_thread_writer_busy" | "grok_resume_missing_session";
      resumeErrorClass: "missing_rollout" | "thread_writer_busy" | "missing_session";
      recoveryAction: "fallback_fresh_thread";
      message: string;
      details?: string;
      requestedSessionId?: string;
    }
  | {
      /**
       * Payload-free observation of the tool surfaces a runtime startup
       * actually exposed (or could not expose through its protocol). This is
       * diagnostic-only: it must not refresh progress or satisfy readiness.
       */
      kind: "runtime_tooling";
      source: "codex_app_server";
      sessionRequestMethod: "thread/start" | "thread/resume";
      nativeToolInventoryObservation: "unreported_by_app_server";
      cliTransportConfigured: boolean;
      managedMcpConfigured: boolean;
      managedMcpStatus: "not_configured" | "pending" | "ready" | "failed";
    }
  | {
      kind: "telemetry";
      name: "token_usage" | "rate_limits" | "recovery";
      source?: string;
      usageKind?: "cumulative_session" | "per_turn" | "unknown";
      sessionId?: string;
      turnId?: string;
      runtimeResultId?: string;
      attrs: Record<string, string | number | boolean>;
    };

// ── Spawn Context ──
// Everything a driver needs to spawn a CLI process.

export interface SpawnContext {
  agentId: string;
  config: AgentConfig;
  /**
   * Long-lived standing instructions for the runtime. Drivers that support a
   * native instruction layer should mount this there so it survives compaction
   * and can be refreshed on resume.
   */
  standingPrompt: string;
  /**
   * Dynamic per-turn input: wake messages, unread summaries, migration hints,
   * and other ephemeral context that belongs in the normal conversation layer.
   */
  prompt: string;
  workingDirectory: string;
  /**
   * Absolute path to the bundled `slock` cli entry script. Drivers that have
   * been ported to CLI-first communication inject this into the spawned process
   * so the agent can invoke the cli for chat/task/attachment operations without
   * depending on a globally installed `slock` binary.
   */
  slockCliPath: string;
  daemonApiKey: string;
  /** Version of the daemon process that owns this spawn/proxy. */
  daemonVersion?: string | null;
  /** Version of the Computer carrier hosting that daemon, when present. */
  computerVersion?: string | null;
  slockHome?: string;
  launchId?: string | null;
  processInstanceId?: string | null;
  agentCredentialProxyInboxCoordinator?: AgentProxyInboxCoordinator;
  /** Shared per-agent Computer-local app Inbox used by the credential proxy. */
  agentAppInbox?: AgentAppInboxStore;
  cliTransportTraceDir?: string | null;
  tracer?: Tracer;
}

// ── Spawn Result ──
// Returned by driver.spawn() — the process plus an optional initial stdin write.

export interface SpawnResult {
  process: ChildProcess;
}

export interface RuntimeProbeResult {
  available: boolean;
  version?: string;
  diagnostic?: string;
}

export interface RuntimeLaunchVersionPolicy {
  /** Exact versions that are proven incompatible and must not launch. */
  readonly knownBadVersions: readonly string[];
  /** Field-tested working version used for context in messages, not a hard floor. */
  readonly testedGoodVersion: string;
  /** User-facing runtime name, for example "Claude Code". */
  readonly displayName: string;
  /** Probe the exact executable selected by this launch config. */
  probe(config: AgentConfig, context: { workingDirectory: string }): RuntimeProbeResult;
}

export type RuntimeTransport = "child_process" | "sdk" | "http_remote";

export type RuntimeLifecycleModel =
  | "turn_based"
  | "persistent_stream"
  | "app_server"
  | "sdk_session";

export type RuntimeStdoutChannel = "diagnostic" | "structured_protocol";

export interface RuntimeSessionDescriptor {
  transport: RuntimeTransport;
  lifecycle: RuntimeLifecycleModel;
  stdout: {
    channel: RuntimeStdoutChannel;
  };
  input: {
    initial: "start" | "request" | "unsupported";
    idle: "stdin" | "request" | "sdk_prompt" | "unsupported";
    busy: "stdin_steer" | "request" | "sdk_steer" | "unsupported";
  };
  readiness: "spawned" | "stdout_signal" | "healthcheck" | "sdk_ready";
  turnBoundary: "parsed_event" | "sdk_event" | "process_exit";
  startPolicy: "immediate" | "defer_until_concrete_message";
  inFlightWake: "queue" | "steer" | "spawn_new" | "coalesce_into_pending";
  busyDelivery: "direct" | "notification" | "none";
  postTurn: "keep_alive" | "close_stdin" | "terminate_process";
}

export type RuntimeSendResult =
  | { ok: true; acceptedAs: "prompt" | "steer" | "notification" | "request" }
  | {
      ok: false;
      reason: "unsupported" | "busy_rejected" | "closed" | "runtime_error";
      error?: string;
    };

export interface RuntimeExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  reason?: "requested" | "runtime_exit" | "error" | "timeout";
}

export type RuntimeToolDiagnosticTrigger =
  | "runtime_inactivity_tripwire"
  | "manual_probe"
  | "testbed_acceptance";

export type RuntimeToolDiagnosticClassification =
  | "running_with_recent_progress"
  | "running_no_observed_progress"
  | "completion_loss"
  | "pending_liveness_unknown"
  | "runtime_inactive_without_pending_tool"
  | "not_pending"
  | "unknown";

export type RuntimeToolDiagnosticSnapshot = {
  classification: RuntimeToolDiagnosticClassification;
  toolExecutionInstanceId: string;
  processInstanceId?: string;
  toolPending: boolean;
  toolAgeMs?: number;
  lastProgressAgeMs?: number;
  processLiveness: "alive" | "exited" | "not_spawned" | "unavailable" | "unknown";
  progressState: "recent" | "stale" | "never_observed" | "unavailable";
  negativeEvidenceBucket:
    | "none"
    | "process_carrier_missing"
    | "process_probe_unavailable"
    | "progress_not_observable"
    | "runtime_session_identity_missing"
    | "turn_identity_missing"
    | "join_key_missing"
    | "producer_stale_or_unreachable";
};

export type RuntimeToolDiagnosticInput = {
  trigger: RuntimeToolDiagnosticTrigger;
  runtimeInactivityAgeMs: number;
  observationIntervalMs?: number;
};

export interface RuntimeSession {
  readonly descriptor: RuntimeSessionDescriptor;
  readonly pid?: number;
  readonly currentSessionId?: string | null;
  readonly currentRuntimeHomeDir?: string | null;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly closed: boolean;

  /**
   * Read-only OS liveness introspection (signal-0), NOT control IO — exposed so
   * managers query liveness through the session boundary (RS-011) instead of
   * poking the raw pid. Returns `undefined` when there is no pid to probe,
   * `true` when the process appears alive (including EPERM), `false` when the
   * probe proves it dead.
   */
  isAlive(): boolean | undefined;

  /** Read-only tool/process diagnosis. It may emit fact spans but cannot mutate runtime behavior. */
  emitToolDiagnosticSnapshots?(
    input: RuntimeToolDiagnosticInput,
  ): RuntimeToolDiagnosticSnapshot[];

  on(event: "runtime_event", cb: (event: ParsedEvent) => void): void;
  on(event: "stdout", cb: (text: string) => void): void;
  on(event: "stderr", cb: (text: string) => void): void;
  on(event: "error", cb: (error: Error) => void): void;
  on(event: "exit" | "close", cb: (info: RuntimeExitInfo) => void): void;

  start(input: { text: string; sessionId?: string | null }): Promise<RuntimeSendResult>;
  send(input: {
    mode: "idle" | "busy";
    text: string;
    sessionId?: string | null;
  }): RuntimeSendResult | Promise<RuntimeSendResult>;
  stop(opts?: {
    signal?: NodeJS.Signals;
    forceAfterMs?: number;
    reason?: string;
  }): Promise<void>;
  dispose?(): Promise<void>;
}

// ── Runtime Driver ──
// Minimal interface encapsulating runtime-specific behavior.

export interface RuntimeDriver {
  /** Short ID matching RUNTIMES[].id (e.g. "claude", "codex") */
  readonly id: string;

  /** Structured lifecycle policy. */
  readonly lifecycle: RuntimeLifecycleContract;

  /** Structured Slock communication policy. */
  readonly communication: RuntimeCommunicationContract;

  /** Semantic meaning of stdout chunks emitted by this runtime transport. */
  readonly stdoutChannel?: RuntimeStdoutChannel;

  /** Native session recovery behavior. */
  readonly session: RuntimeSessionContract;

  /** Model detection and launch-compatibility policy. */
  readonly model: RuntimeModelContract;

  /**
   * Which runtime event means startup is healthy enough to dismiss the launch
   * watchdog. App-server runtimes can have a usable session id before the
   * first turn has actually been accepted by the server.
   */
  readonly startupReadiness?: RuntimeStartupReadiness;

  /**
   * Whether a launch config `sessionId` is only a native resume target until
   * this process emits `session_init`. These drivers must not treat config
   * session ids as live delivery sessions.
   */
  readonly requiresSessionInitForDelivery?: boolean;

  /**
   * When a freshly observed runtime session id can safely be used for live
   * delivery/resume. Some CLIs expose the session id before the backing
   * conversation is persisted; for those, wait for the producing turn boundary.
   */
  readonly liveSessionReadyAt?: "session_init" | "turn_end";

  /**
   * Whether the runtime keeps a live process that can accept follow-up messages
   * over stdin while the daemon keeps it alive.
   */
  readonly supportsStdinNotification: boolean;

  /** Whether the daemon should close stdin after a turn ends so the runtime can exit cleanly. */
  readonly endStdinOnTurnEnd?: boolean;

  /**
   * Whether the daemon should terminate the spawned process after the runtime
   * reports a turn boundary. This is for per-turn CLIs whose auxiliary
   * transports can keep the process alive after the assistant turn is done.
   */
  readonly terminateProcessOnTurnEnd?: boolean;

  /**
   * Whether an idle start with no concrete wake message can be represented by
   * cached daemon state instead of spawning the runtime immediately.
   */
  readonly deferSpawnUntilMessage?: boolean;

  /**
   * Whether an incoming delivery is not concrete runtime work and should not
   * wake a deferred/per-turn runtime.
   */
  shouldDeferWakeMessage?(message: AgentMessage): boolean;

  /**
   * How follow-up messages are delivered while the runtime is busy.
   * - "direct": write an inbox-count notification promptly; content stays in
   *   the daemon inbox until the runtime explicitly checks or becomes idle
   * - "notification": send a generic "you have N messages" notification
   * - "none": no stdin delivery while busy (e.g. Codex — exits after each turn)
   */
  readonly busyDeliveryMode: "direct" | "notification" | "none";

  /**
   * Whether the runtime's native stdin transport remains valid while its
   * context compactor is active. Omit to preserve the conservative hold.
   */
  readonly acceptsStdinDuringCompaction?: boolean;

  /** Whether this runtime supports a native standing-prompt layer. */
  readonly supportsNativeStandingPrompt?: boolean;

  /**
   * Driver-owned live busy-delivery gate. APM lifecycle state must never claim
   * a direct steer is available when the runtime driver has already closed the
   * native turn. Drivers without a narrower native gate may omit this method.
   */
  busyDeliveryReadiness?(): RuntimeBusyDeliveryReadiness;

  /**
   * Best-effort availability probe for this runtime on the current machine.
   *
   * This should answer the same question as spawn(): can the daemon actually
   * invoke the runtime from its own non-interactive environment?
   */
  probe?(): RuntimeProbeResult;

  /** Optional creation-time version policy for the exact launch candidate. */
  readonly launchVersionPolicy?: RuntimeLaunchVersionPolicy;

  /**
   * Create a runtime session. SDK/native drivers should implement this instead
   * of forcing their transport through the child-process adapter.
   */
  createSession?(ctx: SpawnContext): RuntimeSession;

  /** Spawn the CLI process and send the initial prompt. */
  spawn(ctx: SpawnContext): SpawnResult | Promise<SpawnResult>;

  /** Parse a single stdout line into zero or more ParsedEvents. */
  parseLine(line: string): ParsedEvent[];

  /**
   * Current runtime-native session identity, if the driver can observe one.
   * Telemetry recorders use this live state rather than launch-time config so
   * session rollovers/forks are preserved as telemetry sequence boundaries.
   */
  readonly currentSessionId?: string | null;

  /**
   * Runtime-native state root observed from launch env or initialize metadata,
   * if the driver can determine it. Used for host-side transcript/profile
   * lookups so they follow the same state tree as the spawned runtime.
   */
  readonly currentRuntimeHomeDir?: string | null;

  /**
   * Encode a text message for live delivery into the running runtime.
   * Returns null if the runtime doesn't support live message delivery.
   */
  encodeStdinMessage(
    text: string,
    sessionId: string | null,
    opts?: { mode?: "idle" | "busy" },
  ): string | null;

  /** Build the full system prompt for first-time agent startup. */
  buildSystemPrompt(config: AgentConfig, agentId: string): AxSurfaceText;

  /**
   * Detect the models this runtime can use on the current machine.
   *
   * Returns a closed terminal source outcome. A detector must never turn a
   * missing config, empty catalog, or read failure into selectable bundled
   * models. Runs on explicit model reads — not per-turn.
   */
  detectModels?(ctx?: RuntimeModelDetectionContext): Promise<RuntimeModelSourceOutcome>;
}

export interface RuntimeModelDetectionContext {
  tracer?: Tracer;
  span?: ActiveSpan;
}
