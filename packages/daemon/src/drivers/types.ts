import type { TurnEndCompactionDriverOutcome, TurnEndContextFacts } from "../turnEndCompaction";
import type { ChildProcess } from "node:child_process";
import type { RuntimeCompactionInterruption } from "@botiverse/raft-shared";
import type { ActiveSpan, AgentConfig, AgentMessage, RuntimeModelSourceOutcome, SubagentLineage, Tracer, AxSurfaceText } from "@botiverse/raft-shared";
import type { AgentProxyInboxCoordinator } from "../agentCredentialProxy";
import type { AgentAppInboxStore } from "../agentAppInbox";
import type { RuntimeTurnOrigin, RuntimeTurnOriginReader } from "../runtimeTurnOrigin";
import type { SpawnContextGeneration } from "../contextGeneration";
import type { AgentNotIdleReason } from "../agentIdle";

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
  /**
   * Whether the runtime tells the daemon when it compacts its context
   * (`compaction_started` / `compaction_finished` events). `reported`: an
   * unchanged context id proves the context still holds what was shown in it,
   * so glimpse shows a thing once per context id. `unreported`: it proves
   * nothing, so glimpse shows it on every use. Required, with no default:
   * every runtime answers it in its own driver.
   */
  compaction: RuntimeCompactionReporting;
  /**
   * What a terminal compaction failure does to the session. `sticks_to_session`:
   * the runtime summarizes the whole session in one request, so once that no
   * longer fits the model every resume fails compaction again (Pi). The daemon
   * counts these failures per session and, after SESSION_NEEDS_RESET_THRESHOLD
   * in a row, refuses to resume it (`session_needs_reset`) until the session is
   * reset or the model changes. `does_not_stick`: nothing is counted.
   * Required, with no default.
   */
  compactionFailure: RuntimeCompactionFailure;
};

export type RuntimeCompactionReporting = "reported" | "unreported";
export type RuntimeCompactionFailure = "sticks_to_session" | "does_not_stick";

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

export type RuntimeTokenUsageKind = "cumulative_session" | "per_turn" | "per_generation" | "unknown";

export type ParsedEvent =
  | { kind: "provider_request"; activity: import("@botiverse/raft-shared").ProviderRequestActivity }
  | { kind: "session_init"; sessionId: string }
  // task #1357 item 1: a Pi session was opened with these model limits
  // registered, built from the config of `configRevision` (null: unknown).
  // Display evidence only: not model progress, readiness or lifecycle.
  | { kind: "model_limits"; sessionId: string; configRevision: number | null; modelLimits: import("@botiverse/raft-shared").ModelLimits }
  | ({ kind: "thinking"; text: string; runtimeTurn?: RuntimeTurnAttribution } & SubagentLineage)
  | ({ kind: "text"; text: string; runtimeTurn?: RuntimeTurnAttribution } & SubagentLineage)
  // `callId` is the runtime's id for the call when it reports one; `tool_output`
  // with the same id ends that call. `ok` is whether the tool call itself
  // succeeded (a non-zero `exitCode` is still ok); `durationMs` is the
  // runtime's own measurement, used instead of the daemon's when present.
  | ({ kind: "tool_call"; name: string; input: any; callId?: string } & SubagentLineage)
  | ({ kind: "tool_output"; name: string; callId?: string; ok?: boolean; durationMs?: number; exitCode?: number } & SubagentLineage)
  // Agent typing line (shared agentTyping.ts): the main agent's shell call
  // `callId` is a `raft message send --target <target>`, found while its
  // arguments were still streaming (`early`) or once they were complete,
  // before the call ran. Display hint only: not model progress or lifecycle.
  | { kind: "send_intent"; callId: string; target: string; early: boolean }
  // `cycleId` pairs a start with its own finish or interruption, when the
  // producer knows the pairing (Pi). Absent: the producer makes no claim.
  // `afterRunEnd`: the runtime had already reported its run's end and its
  // turn end has not come yet (Pi: after agent_end, before agent_settled).
  // It says nothing about whether the session takes a new prompt.
  | { kind: "compaction_started"; cycleId?: number; afterRunEnd?: true }
  | { kind: "compaction_finished"; cycleId?: number }
  | {
      kind: "compaction_interrupted";
      cycleId?: number;
      outcome: "compaction_failed_or_exhausted" | "aborted";
      reason: "manual" | "threshold" | "overflow" | "unknown";
      failureReason?: "recovery_exhausted" | "input_too_large" | "compaction_failed";
      willRetry?: boolean;
    }
  | { kind: "review_started" }
  | { kind: "review_finished" }
  | {
      kind: "turn_end";
      sessionId?: string;
      /** task #25 step 2: the turn ended because the daemon interrupted it, not by failing. */
      interrupted?: true;
    }
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
      /**
       * task #379: the runtime declared a provider limit. Either kind takes the
       * existing `rate_limited` delivery backoff (recoverable, cleared by real
       * progress); `quota_exhausted` means the window is used up until it
       * resets, `transient_rate_limit` is a short throttle. `resetsAt` is only
       * set when the runtime reported it; it is never inferred.
       */
      providerLimit?: { kind: "quota_exhausted" | "transient_rate_limit"; resetsAt?: string };
      /**
       * The runtime's typed API error behind this one (Claude Code's `error` /
       * `api_error_code` and `api_error_status`): its codes and HTTP status,
       * never its wording. Read for the error's trace class and status.
       */
      providerError?: { codes?: string[]; httpStatus?: number };
      compaction?: RuntimeCompactionInterruption;
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
      /** Category only (traceCategory): the role of a raw response message item. */
      role?: string;
      /** Category only (traceCategory): the agent-message phase, e.g. commentary for suppressed text. */
      phase?: string;
    }
  // A subagent (Claude `Agent` tool) lifecycle/activity signal derived from
  // EXPLICIT parent_tool_use_id / `system` task-lifecycle lineage — never
  // inferred from display text (APM 1.6 6b). Unlike internal_progress, this is
  // rendered into the trajectory as a subagent-marked activity. Carries only
  // closed ids / bounded tokens (Q8 discipline): no raw prompt or output.
  | {
      kind: "subagent_progress";
      source: "claude_task_lifecycle" | "claude_parent_tool_use" | "codex_subagent_thread" | "kimi_subagent";
      /** Bounded lifecycle phase from the `system` envelope kind. */
      phase: "started" | "progress" | "notification" | "active";
      /** Outer `Agent` tool_use id (Codex: the `spawn_agent` call id) that owns this subagent turn. */
      parentToolUseId?: string;
      /** Declared subagent role (bounded label, never content). */
      subagentType?: string;
      /** Claude `system` task-lifecycle envelope id; Codex: the subagent's own thread id. */
      taskId?: string;
      /**
       * Claude task lifecycle only: what the task is, from its `task_type`.
       * A `command` (a shell command Claude Code runs as a task) or `other`
       * task is background work, not a sub-agent. Absent: a sub-agent (older
       * Claude Code named no type and sent these only for sub-agents).
       */
      taskKind?: "agent" | "command" | "other";
      /**
       * task #1260 — terminal status of a `task_notification` envelope, the
       * closed vocabulary Claude documents (completed | failed | stopped).
       * Absent on other phases and on an unknown status value.
       */
      taskStatus?: "completed" | "failed" | "stopped";
      /** Bounded tool name from the envelope's `last_tool_name`, if present. */
      lastToolName?: string;
      payloadBytes?: number;
    }
  | ({
      kind: "runtime_diagnostic";
      itemType: string;
      message: string;
      details?: string;
      path?: string;
      range?: unknown;
      payloadBytes?: number;
      sessionId?: string;
      inputEvidence?: "nonempty" | "unknown";
      reasonPresent?: boolean;
    } & (
      | { severity: "warning"; source: "codex_app_server_notification" | "grok_acp_notification" }
      | { severity: "info"; source: "pi_empty_response"; itemType: "empty_response" | "whitespace_response" }
    ))
  | {
      kind: "runtime_recovery";
      source: "codex_resume_missing_rollout" | "codex_resume_thread_writer_busy" | "codex_resume_archived" | "grok_resume_missing_session";
      resumeErrorClass: "missing_rollout" | "thread_writer_busy" | "archived" | "missing_session";
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
      name: "token_usage" | "usage_omission" | "rate_limits" | "recovery" | "request_diagnostic" | "provider_request";
      source?: string;
      usageKind?: RuntimeTokenUsageKind;
      sessionId?: string;
      turnId?: string;
      runtimeResultId?: string;
      attrs: Record<string, string | number | boolean>;
      /** A provider quota reading (Claude `rate_limit_event`); absent when the row carried none that could be read. */
      providerQuota?: ProviderQuotaObservation;
    };

/**
 * One reading of the provider's subscription quota, from the top-level fields
 * of Claude Code's `rate_limit_event.rate_limit_info` (schema confirmed in
 * Claude Code 2.1.317). The top level describes the currently limiting window;
 * its `status` says whether requests are refused.
 */
export interface ProviderQuotaObservation {
  status: "allowed" | "allowed_warning" | "rejected";
  /** Fraction of the window used (usually 0-1; can exceed 1). */
  utilization?: number;
  /** Highest warning threshold passed, as a fraction of the limit (1 once rejected). */
  surpassedThreshold?: number;
  /** The limiting window; absent when unreported or a value this daemon does not know. */
  rateLimitType?: ProviderQuotaRateLimitType;
  /** When the window resets, epoch milliseconds; only a plausible reset (within a year from now) is kept. */
  resetsAtMs?: number;
}

/** `rate_limit_info.rateLimitType` values in Claude Code 2.1.317. */
export type ProviderQuotaRateLimitType =
  | "five_hour"
  | "seven_day"
  | "seven_day_opus"
  | "seven_day_sonnet"
  | "seven_day_overage_included"
  | "overage";

// ── Spawn Context ──
// Everything a driver needs to spawn a CLI process.

export interface SpawnContext {
  agentId: string;
  config: AgentConfig;
  /** View Context: where a runtime hosted in this daemon records its model requests; null while off. */
  contextViewRequestLogDir?: () => string | null;
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
  /**
   * task #1277 — cancels this start attempt. Aborted when the agent is stopped
   * or the attempt is replaced while the driver is still resolving or
   * spawning; never by a connection change. Drivers pass it to their bounded
   * probe children and must not create a child once it is aborted.
   */
  launchSignal?: AbortSignal;
  /**
   * Read-only getter for the current foreground turn's origin, bound to THIS process's
   * RuntimeSession. Set by the session itself when it hands the context to spawn / its SDK session
   * factory; anything the manager put here is overwritten. Managed MCP call surfaces read it at call
   * time and never cache it (task #21).
   */
  readTurnOrigin?: RuntimeTurnOriginReader;
  agentCredentialProxyInboxCoordinator?: AgentProxyInboxCoordinator;
  /** A launch with no coordinator (the OAR host) still hears of the messages the Server accepted. */
  agentCredentialProxyMessageCommitted?: AgentProxyInboxCoordinator["recordMessageCommitted"];
  /** A launch with no coordinator (the OAR host) still hears what the Server said about each message send. */
  agentCredentialProxySendOutcome?: AgentProxyInboxCoordinator["recordSendOutcome"];
  /**
   * RFC 081: the agent's CURRENT `AgentConfig.inboxItems` (read at each call,
   * so a flag turned off later is honoured). The proxy's `inbox check`
   * snapshot then leaves out third-party events the Server lists as app items.
   */
  agentCredentialProxyInboxItems?: () => boolean;
  /**
   * RFC 072 context id this spawn publishes, planned by the daemon so the
   * start input it books and the id the CLI reads are the same (glimpse G0),
   * with the driver's compaction declaration. Absent: the transport publishes
   * no id (signal unknown); it never guesses the declaration.
   */
  contextGeneration?: SpawnContextGeneration;
  /** Shared per-agent Computer-local app Inbox used by the credential proxy. */
  agentAppInbox?: AgentAppInboxStore;
  cliTransportTraceDir?: string | null;
  tracer?: Tracer;
  /**
   * task #365: throws when the launch was claimed against a server
   * connection that is no longer the current one. Every driver calls it after
   * its last await and immediately before the runtime comes into existence
   * (a child process: right before `spawn()`; a native session: before its
   * session factory), so no process is created for a stale launch.
   */
  assertLaunchCurrent?: () => void;
}

// ── Spawn Result ──
// Returned by driver.spawn() — the process plus an optional initial stdin write.

export interface SpawnResult {
  process: ChildProcess;
}

/**
 * Structured cause for an unavailable runtime probe. Log severity is chosen from
 * this, never from the diagnostic text: only "not_installed" (the command was
 * not found on PATH / in its known install locations) is an expected state for
 * an optional runtime; every other reason means something is installed but
 * broken and stays a warning.
 */
export type RuntimeProbeUnavailableReason =
  | "not_installed"
  | "probe_failed"
  | "probe_timeout"
  | "permission_denied"
  | "unsupported_version";

export interface RuntimeProbeResult {
  available: boolean;
  version?: string;
  diagnostic?: string;
  /**
   * task #1240 — bounded one-line timing of the PATH lookup behind this probe
   * (phase, ms, budget, outcome per child; no values, output or paths). Goes
   * to the detection trace event; it is not a diagnostic, so a healthy
   * runtime does not warn because of it.
   */
  lookupTiming?: string;
  /** Set only when `available` is false. Absent means unknown (treated as a failure). */
  unavailableReason?: RuntimeProbeUnavailableReason;
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
  /**
   * `kill_unconfirmed`: reconciler step 5's last resort. No exit was seen
   * after the SIGKILL; the session reports one so the agent is released, but
   * it is no evidence that the process is gone.
   */
  reason?: "requested" | "runtime_exit" | "error" | "timeout" | "kill_unconfirmed";
}

export type RuntimeToolDiagnosticTrigger =
  | "runtime_inactivity_tripwire"
  | "manual_probe"
  | "queued_message_recovery"
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
  /**
   * The runtime's own id for the tool call, when it had one. In-memory only
   * (never put on a trace): it lets the daemon match each snapshot to one open
   * call (task #1302).
   */
  runtimeToolCallId?: string;
  /** completion_loss only: whether the exited child's process group is gone. */
  processGroupLiveness?: "alive" | "exited" | "unknown";
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

  /**
   * Task #1310: read-only view of the runtime's open provider calls, for the
   * stall events. Absent for runtimes that do not observe their model calls.
   */
  providerCallSnapshot?(): RuntimeProviderCallSnapshot;

  /** Read-only tool/process diagnosis. It may emit fact spans but cannot mutate runtime behavior. */
  emitToolDiagnosticSnapshots?(
    input: RuntimeToolDiagnosticInput,
  ): RuntimeToolDiagnosticSnapshot[];

  on(event: "runtime_event", cb: (event: ParsedEvent) => void): void;
  on(event: "stdout", cb: (text: string) => void): void;
  on(event: "stderr", cb: (text: string) => void): void;
  on(event: "error", cb: (error: Error) => void): void;
  on(event: "exit" | "close", cb: (info: RuntimeExitInfo) => void): void;

  /**
   * `origin` is the single Raft message this prompt answers, or null. Sessions adopt it only when the
   * input is accepted as a NEW prompt; a steer never changes the current turn's origin (task #21).
   */
  start(input: { text: string; sessionId?: string | null; origin?: RuntimeTurnOrigin | null }): Promise<RuntimeSendResult>;
  send(input: {
    mode: "idle" | "busy";
    text: string;
    sessionId?: string | null;
    origin?: RuntimeTurnOrigin | null;
  }): RuntimeSendResult | Promise<RuntimeSendResult>;
  /**
   * Reconciler step 5: SIGTERM (or the runtime's native shutdown), then after
   * `forceAfterMs` (AGENT_STOP_KILL_GRACE_MS by default) a SIGKILL of the
   * whole process tree. Settles once the exit is observed, or after
   * `confirmAfterMs` more without one (`onKillUnconfirmed`; the session then
   * reports the exit itself so the agent can be released). A second call
   * joins the first; with `SIGKILL` it skips what is left of the grace.
   * Nothing is written to a session once its stop has begun.
   */
  stop(opts?: RuntimeStopOptions): Promise<void>;
  dispose?(): Promise<void>;
  /**
   * task #25 step 2: end the current turn without ending the process, when
   * the runtime has a native way to (Claude Code's stream-json interrupt,
   * Pi's abort). "sent" means the request went out; the turn's own end event
   * says it worked. Absent or "unsupported": the caller restarts instead.
   */
  interruptTurn?(): "sent" | "unsupported";

  /**
   * #proj-runtime:#54 phase 3, in-process runtimes (Pi, Built-in, Kimi SDK):
   * the live session's last context and its model's window, for the turn-end
   * compaction decision. Absent: the runtime is asked as Claude is (`/compact`).
   */
  turnEndContextFacts?(): Promise<TurnEndContextFacts>;

  /**
   * Run the runtime's own compaction on an idle session and resolve once it
   * settled. Only called at a turn end with nothing running, held or queued.
   */
  compactAtTurnEnd?(): Promise<TurnEndCompactionDriverOutcome>;
  /**
   * Cancel a `compactAtTurnEnd()` the manager gave up on (its cap), and
   * resolve once the session takes prompts again (Pi refuses a prompt while
   * a compaction is open). Absent: the manager releases without cancelling.
   */
  cancelTurnEndCompaction?(): Promise<void>;
  /** #proj-runtime:#41: ask the runtime to stop one sub-agent's turn (RuntimeDriver.encodeSubagentInterruptRequest). */
  interruptSubagent?(subagentTaskId: string): "sent" | "not_running" | "unsupported";
  /**
   * After a native interrupt ended the turn: kill what the turn started in
   * the runtime's process tree, as the restart path does. Codex leaves the
   * interrupted command running. Absent on in-process sessions, whose tree is
   * the daemon's.
   */
  killTurnProcesses?(startedAtOrAfterMs: number, startedAtOrBeforeMs: number): Promise<{ killed: number; leftAlone: number }>;
  /**
   * pi session rotation (pi#10642): APM calls this at every turn end. A
   * runtime with a rotation due (a compaction finished since its last
   * rotation) reads `hold` right before it rotates, after its own turn has
   * settled; a hold keeps the rotation due for the next turn end. Absent on
   * runtimes that do not rotate.
   */
  rotateSessionIfDue?(hold: () => RuntimeSessionRotationHold | null): void;
}

/** Why the agent is not idle (agentIdle.ts); a session rotation runs only when idle. */
export type RuntimeSessionRotationHold = AgentNotIdleReason;

export interface RuntimeStopOptions {
  signal?: NodeJS.Signals;
  /** Grace before the tree kill; AGENT_STOP_KILL_GRACE_MS by default. */
  forceAfterMs?: number;
  /** After the tree kill, how long the exit is awaited; AGENT_STOP_KILL_CONFIRM_MS by default. */
  confirmAfterMs?: number;
  reason?: string;
  turnTreeKill?: RuntimeTurnTreeKill;
  /** The grace ran out: the tree was SIGKILLed. */
  onEscalated?: (escalation: { pid: number | undefined; graceMs: number; treeKilledCount: number }) => void;
  /** No exit was observed `confirmAfterMs` after the SIGKILL. */
  onKillUnconfirmed?: (info: { pid: number | undefined; graceMs: number; confirmMs: number }) => void;
}

/**
 * task #25 step 2: on a stop that interrupts a turn, kill the descendants the
 * turn started (start time at or after `startedAtOrAfterMs`) at the stop
 * deadline, whether or not the runtime exited; leave older or unknown ones.
 */
export interface RuntimeTurnTreeKill {
  startedAtOrAfterMs: number;
  onResult?: (result: { killed: number; leftAlone: number }) => void;
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
   * The CLI version this driver instance read for its last launch, when it
   * reads one at spawn (OpenCode does, to pick its launch line). Absent: the
   * manager falls back to the version the daemon last detected.
   */
  readonly launchedCliVersion?: string | null;

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
   * The runtime gives the agent a tool to start sub-agents, so its standing
   * prompt renders the "Working through sub-agents" section when the Server's
   * `subagentDelegation` flag is on (SystemPromptOptions.supportsSubagents).
   * Absent/false: that flag changes nothing for this runtime.
   */
  readonly supportsSubagents?: boolean;

  /**
   * When a subagent finishes after the agent's turn has ended, the runtime
   * only queues the result for the agent's next turn and does not start one
   * itself (Codex: a `<subagent_notification>` input item). The daemon then
   * starts that turn once the last background task ends and the agent is
   * idle. Absent/false: the runtime opens it by itself (Claude Code).
   */
  readonly needsWakeAfterSubagents?: boolean;

  /**
   * The runtime runs only on the OAR host (drivers/oarOnly.ts): `spawn` is
   * never reached. The router and the OAR host key on this flag, never on a
   * list of runtime names: no start of it goes to the legacy host, and one
   * the OAR host cannot run fails (agentHostRouter.ts).
   */
  readonly oarOnly?: boolean;

  /**
   * The runtime is part of the Computer itself (an SDK running in the daemon
   * process), not a CLI found on PATH: the version its `probe` reports changes
   * only when the Computer does. Such a runtime is left out of the runtime CLI
   * version record (runtimeCliVersionTracker.ts), whose downgrade notice is
   * about an older CLI earlier on PATH.
   */
  readonly shipsWithComputer?: boolean;

  /**
   * task #13: the runtime rebuilds the standing prompt from this launch on
   * every start, so a resumed session already runs on the current prompt
   * (Pi / Built-in: systemPromptOverride; OpenCode: per-process agent config;
   * Kimi SDK: resumeSession renders the given roleAdditional).
   * Absent/false: a resumed session keeps its original prompt, and the daemon
   * re-delivers a changed one in the first input (standingPromptRefresh.ts).
   */
  readonly standingPromptRefreshesOnResume?: boolean;

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
   * Whether the runtime itself reports a turn as accepted or running. Drivers
   * that track the native turn lifecycle (Codex app-server) expose it so the
   * daemon's busy state can be checked against evidence; omit when unknown.
   */
  readonly hasLiveTurn?: boolean;

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
  /**
   * task #25 step 2: the stdin line that interrupts the current turn, for a
   * runtime whose stream protocol has one (Claude Code's control_request).
   */
  encodeInterruptRequest?(): string | null;
  /**
   * #proj-runtime:#41: the stdin line that stops one running sub-agent's
   * turn, by its `SubagentLineage.taskId`; null when no such sub-agent turn
   * is running. Absent: the runtime cannot stop one sub-agent.
   */
  encodeSubagentInterruptRequest?(subagentTaskId: string): string | null;
  /**
   * #proj-runtime:#41: the runtime's session (not a stdin line) stops one
   * subagent: `RuntimeSession.interruptSubagent` does it (Kimi SDK, its
   * background subagents).
   */
  readonly stopsSubagentsInSession?: boolean;
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

/** Task #1310: open provider calls at one moment. `oldest` is the longest-open call, absent when none is open. */
export interface RuntimeProviderCallSnapshot {
  openCount: number;
  oldest?: {
    /** The highest stage the call has been observed to reach. */
    phase: "started" | "headers" | "streaming";
    /** Time-window attribution only, not causal. */
    callContext: "compaction" | "outside_compaction" | "unknown";
    ageMs: number;
    msSinceLastStreamEvent?: number;
  };
}
