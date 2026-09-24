// Compile-time proofs for the AgentProcess state discriminated unions. This is
// NOT a runtime test: its teeth are the ts-expect-error directives below,
// exercised by `pnpm --filter @botiverse/raft-daemon typecheck`. If a union is
// widened to allow the rejected shape, the now-unused directive fails
// typecheck.
import type {
  AgentProcessActivationState,
  AgentProcessCompactionState,
  AgentProcessExitState,
  AgentProcessStartupState,
} from "./agentProcessManager.js";
import type { LaunchActivationTransitionState } from "./launchPhaseTransition.js";

const fakeTimer = {} as ReturnType<typeof setTimeout>;
const fakeTransition = {} as LaunchActivationTransitionState;

const validCompaction: AgentProcessCompactionState = {
  kind: "active",
  startedAt: 1,
  watchdog: fakeTimer,
};
const validExit: AgentProcessExitState = { kind: "exited", code: 0, signal: null };
const validStartup: AgentProcessStartupState = {
  kind: "waiting",
  timer: fakeTimer,
  wakeMessage: undefined,
  unreadSummary: undefined,
  resumePrompt: undefined,
};
const validActivation: AgentProcessActivationState = { kind: "open", transition: fakeTransition };

// @ts-expect-error proof-of-catch: old compaction writes could set a watchdog without startedAt.
const compactionWatchdogWithoutStartedAt: AgentProcessCompactionState = { kind: "active", watchdog: fakeTimer };

// @ts-expect-error proof-of-catch: a live process cannot carry exit result fields.
const liveExitWithCode: AgentProcessExitState = { kind: "live", code: 0 };

// @ts-expect-error proof-of-catch: delivered activation cannot still have an open transition.
const deliveredActivationWithOpenTransition: AgentProcessActivationState = { kind: "delivered", transition: fakeTransition };

const readyStartupWithTimer: AgentProcessStartupState = {
  kind: "ready",
  // @ts-expect-error proof-of-catch: ready startup cannot retain the startup timeout timer.
  timer: fakeTimer,
  wakeMessage: undefined,
  unreadSummary: undefined,
  resumePrompt: undefined,
};

void validCompaction;
void validExit;
void validStartup;
void validActivation;
void compactionWatchdogWithoutStartedAt;
void liveExitWithCode;
void deliveredActivationWithOpenTransition;
void readyStartupWithTimer;
