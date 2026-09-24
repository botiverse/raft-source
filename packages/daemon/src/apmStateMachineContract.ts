import type {
  ApmExpectedTerminationReason,
  ApmStalledRecoveryBlockReason,
  ApmStartupTimeoutBlockReason,
} from "./apmStateMachine.js";

export type ApmUserVisibleStatus =
  | "starting"
  | "running"
  | "stalled"
  | "recovering"
  | "inactive"
  | "error";

export type ApmProviderEventClass =
  | "runtime_progress_recent"
  | "runtime_no_ready_timeout"
  | "tool_output_no_progress_stale"
  | "active_tool_without_recovery_evidence"
  | "resume_missing_rollout"
  | "resume_thread_writer_busy"
  | "resume_permission_denied"
  | "control_plane_reconnect";

export type ApmStatusTransitionCoverage =
  | "stalled_recovery_reducer"
  | "startup_timeout_reducer"
  | "provider_error_reducer"
  | "driver_error_classifier"
  | "control_plane_boundary";

export type ApmStatusTransitionTestStatus = "executable" | "anchor";

export type ApmRecoveryAction =
  | "terminate_for_queued_message"
  | "fallback_fresh_thread";

export interface ApmFakeClockFixture {
  lastRuntimeProgressAtMs: number;
  nowMs: number;
  staleThresholdMs: number;
}

export interface ApmStatusTransitionExpectation {
  shouldTerminate?: boolean;
  alreadyRecovering?: boolean;
  expectedTerminationReason?: ApmExpectedTerminationReason;
  stalledRecoveryBlockReason?: ApmStalledRecoveryBlockReason | null;
  startupTimeoutBlockReason?: ApmStartupTimeoutBlockReason | null;
  recoveryAction?: ApmRecoveryAction;
  resumeErrorClass?: "missing_rollout" | "thread_writer_busy" | "permission_denied";
  traceEvent?: "runtime.progress.stalled" | "runtime.error" | "runtime.telemetry.recovery";
  runtimeTraceEvent?: "runtime.start.timeout" | "runtime.progress.stalled";
  controlPlaneTraceEvent?: "daemon.connection.reconnect_scheduled";
}

export interface ApmStatusTransitionContractRow {
  id: string;
  from: ApmUserVisibleStatus;
  eventClass: ApmProviderEventClass;
  to: ApmUserVisibleStatus;
  coverage: ApmStatusTransitionCoverage;
  testStatus: ApmStatusTransitionTestStatus;
  fakeClock?: ApmFakeClockFixture;
  expectation: ApmStatusTransitionExpectation;
  invariant: string;
}

const STALE_THRESHOLD_MS = 15 * 60_000;

const APM_STATUS_TRANSITION_CONTRACT_ROWS = [
  {
    id: "direct-stdin-tool-output-stale-queued-message",
    from: "running",
    eventClass: "tool_output_no_progress_stale",
    to: "recovering",
    coverage: "stalled_recovery_reducer",
    testStatus: "executable",
    fakeClock: {
      lastRuntimeProgressAtMs: 0,
      nowMs: STALE_THRESHOLD_MS + 60_000,
      staleThresholdMs: STALE_THRESHOLD_MS,
    },
    expectation: {
      shouldTerminate: true,
      expectedTerminationReason: "stalled_recovery",
      stalledRecoveryBlockReason: null,
      recoveryAction: "terminate_for_queued_message",
      traceEvent: "runtime.progress.stalled",
      runtimeTraceEvent: "runtime.progress.stalled",
    },
    invariant: "A queued message may recover a stale direct-stdin runtime after the tool batch has closed.",
  },
  {
    id: "recent-runtime-progress-blocks-stalled-recovery",
    from: "running",
    eventClass: "runtime_progress_recent",
    to: "running",
    coverage: "stalled_recovery_reducer",
    testStatus: "executable",
    fakeClock: {
      lastRuntimeProgressAtMs: 0,
      nowMs: STALE_THRESHOLD_MS - 1_000,
      staleThresholdMs: STALE_THRESHOLD_MS,
    },
    expectation: {
      shouldTerminate: false,
      expectedTerminationReason: null,
      stalledRecoveryBlockReason: "runtime_progress_recent",
    },
    invariant: "Recent runtime progress must block queued-message stalled recovery.",
  },
  {
    id: "active-tool-without-direct-recovery-evidence-blocks-restart",
    from: "running",
    eventClass: "active_tool_without_recovery_evidence",
    to: "running",
    coverage: "stalled_recovery_reducer",
    testStatus: "executable",
    fakeClock: {
      lastRuntimeProgressAtMs: 0,
      nowMs: STALE_THRESHOLD_MS + 60_000,
      staleThresholdMs: STALE_THRESHOLD_MS,
    },
    expectation: {
      shouldTerminate: false,
      expectedTerminationReason: null,
      stalledRecoveryBlockReason: "runtime_not_restartable",
    },
    invariant: "An active tool keeps a direct-stdin runtime from being restarted unless recovery evidence says stdin is broken.",
  },
  {
    id: "startup-no-ready-timeout-terminates",
    from: "starting",
    eventClass: "runtime_no_ready_timeout",
    to: "error",
    coverage: "startup_timeout_reducer",
    testStatus: "executable",
    expectation: {
      shouldTerminate: true,
      expectedTerminationReason: "startup_timeout",
      startupTimeoutBlockReason: null,
      traceEvent: "runtime.error",
      runtimeTraceEvent: "runtime.start.timeout",
    },
    invariant: "A startup timeout with no runtime progress terminates startup instead of waiting forever.",
  },
  {
    id: "startup-progress-started-blocks-timeout",
    from: "starting",
    eventClass: "runtime_progress_recent",
    to: "running",
    coverage: "startup_timeout_reducer",
    testStatus: "executable",
    expectation: {
      shouldTerminate: false,
      expectedTerminationReason: null,
      startupTimeoutBlockReason: "runtime_progress_started",
    },
    invariant: "Any startup runtime progress converts the no-ready timeout into a non-termination path.",
  },
  {
    id: "codex-resume-missing-rollout-falls-back-fresh-thread",
    from: "running",
    eventClass: "resume_missing_rollout",
    to: "recovering",
    coverage: "driver_error_classifier",
    testStatus: "executable",
    expectation: {
      shouldTerminate: false,
      expectedTerminationReason: null,
      recoveryAction: "fallback_fresh_thread",
      resumeErrorClass: "missing_rollout",
      traceEvent: "runtime.telemetry.recovery",
    },
    invariant: "Missing rollout recovery is a fresh-thread fallback and must be traced as recovery, not as permission failure.",
  },
  {
    id: "codex-resume-thread-writer-busy-falls-back-fresh-thread",
    from: "running",
    eventClass: "resume_thread_writer_busy",
    to: "recovering",
    coverage: "driver_error_classifier",
    testStatus: "executable",
    expectation: {
      shouldTerminate: false,
      expectedTerminationReason: null,
      recoveryAction: "fallback_fresh_thread",
      resumeErrorClass: "thread_writer_busy",
      traceEvent: "runtime.telemetry.recovery",
    },
    invariant: "A Codex active-writer resume failure means the old thread is unusable for this writer and must fallback fresh, not terminal the agent.",
  },
  {
    id: "codex-resume-permission-denied-stays-terminal-error",
    from: "running",
    eventClass: "resume_permission_denied",
    to: "error",
    coverage: "driver_error_classifier",
    testStatus: "executable",
    expectation: {
      shouldTerminate: false,
      expectedTerminationReason: null,
      resumeErrorClass: "permission_denied",
      traceEvent: "runtime.error",
    },
    invariant: "Permission denied is terminal runtime error and must not fallback to a fresh thread.",
  },
  {
    id: "control-plane-reconnect-does-not-imply-runtime-recovery",
    from: "running",
    eventClass: "control_plane_reconnect",
    to: "running",
    coverage: "control_plane_boundary",
    testStatus: "executable",
    expectation: {
      shouldTerminate: false,
      expectedTerminationReason: null,
      controlPlaneTraceEvent: "daemon.connection.reconnect_scheduled",
    },
    invariant: "Control-plane reconnect is not itself runtime no-ready, stalled recovery, or provider error.",
  },
] as const satisfies readonly ApmStatusTransitionContractRow[];

export const APM_STATUS_TRANSITION_CONTRACT: readonly ApmStatusTransitionContractRow[] =
  APM_STATUS_TRANSITION_CONTRACT_ROWS;

export type ApmStatusTransitionContractId = typeof APM_STATUS_TRANSITION_CONTRACT_ROWS[number]["id"];

export function getApmStatusTransitionContract(
  id: ApmStatusTransitionContractId,
): ApmStatusTransitionContractRow {
  const row = APM_STATUS_TRANSITION_CONTRACT.find((candidate) => candidate.id === id);
  if (!row) throw new Error(`Missing APM status transition contract row: ${id}`);
  return row;
}
