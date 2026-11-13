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
} from "./agentProcessManager";

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

// Reconciler step 5: no process state holds a stop-escalation timer; the
// escalation lives in RuntimeSession.stop.
// @ts-expect-error A live process cannot retain a stop-escalation timer.
const liveWithStopTimer: AgentProcessExitState = { kind: "live", stalledRecoverySigtermTimer: timeoutHandle };

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
void liveWithStopTimer;
void pendingTrajectoryWithoutTimer;
void idleRuntimeErrorBackoffWithTimer;
