// Compile-time proofs that agent process timer states cannot hold detached
// timer handles. This is NOT a runtime test: its teeth are the
// ts-expect-error directives below, exercised by
// `pnpm --filter @botiverse/raft-daemon typecheck`. If a state is widened to
// allow the rejected shape, the now-unused directive fails typecheck.
import type {
  ActivityHeartbeatTimerState,
  AgentProcessCompactionState,
  AgentProcessExitState,
  AgentProcessStartupState,
  PendingTrajectoryState,
  RuntimeErrorDeliveryBackoffState,
} from "./agentProcessManager.js";

const timeoutHandle = null as unknown as ReturnType<typeof setTimeout>;
const intervalHandle = null as unknown as ReturnType<typeof setInterval>;

// @ts-expect-error Activity heartbeat timers must be attached to active state.
const detachedHeartbeat: ActivityHeartbeatTimerState = { timer: intervalHandle };

const readyStartupWithTimer: AgentProcessStartupState = {
  kind: "ready",
  wakeMessage: undefined,
  unreadSummary: undefined,
  resumePrompt: undefined,
  // @ts-expect-error Ready startup cannot retain the startup timeout handle.
  timer: timeoutHandle,
};

// @ts-expect-error Inactive compaction cannot retain a watchdog handle.
const inactiveCompactionWithWatchdog: AgentProcessCompactionState = { kind: "none", watchdog: timeoutHandle };

const exitedWithStalledRecoveryTimer: AgentProcessExitState = {
  kind: "exited",
  code: null,
  signal: null,
  // @ts-expect-error Exited process cannot retain the stalled-recovery escalation timer.
  stalledRecoverySigtermTimer: timeoutHandle,
};

// @ts-expect-error Pending trajectory state cannot exist without a live coalescing timer.
const pendingTrajectoryWithoutTimer: PendingTrajectoryState = { kind: "text", text: "queued", timer: null };

// @ts-expect-error Idle runtime-error backoff cannot retain a timer handle.
const idleRuntimeErrorBackoffWithTimer: RuntimeErrorDeliveryBackoffState = {
  kind: "idle",
  attempts: 0,
  untilMs: 0,
  timer: timeoutHandle,
  reason: null,
};

void detachedHeartbeat;
void readyStartupWithTimer;
void inactiveCompactionWithWatchdog;
void exitedWithStalledRecoveryTimer;
void pendingTrajectoryWithoutTimer;
void idleRuntimeErrorBackoffWithTimer;
