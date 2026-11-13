import { vi } from "vitest";
import { setSessionReadyDeliveryRetrySchedulerFactoryForTesting } from "../agentInboxDeliveryDebt";

/**
 * Teardown for a test's AgentProcessManager. Call it before restoring the
 * test's fetch mocks.
 *
 * A test that ends (or fails) while a start is queued, held, or between a
 * restart timer and its credential mint leaves work that runs a few
 * milliseconds later, under the next test. Its runner-credential mint then
 * hits the network guard and that next, unrelated test fails. Teardown
 * therefore:
 *
 * 1. stops new start work: queued and capability-held starts are cancelled
 *    (cancelling the queue also clears the start pump timer), restart
 *    snapshots and restart timers are dropped;
 * 2. fences the manager: from here on a start does nothing and a mint fails
 *    locally, so a timer nobody cleared cannot reach the network later;
 * 3. waits (bounded) for starts already in flight to settle, so their failure
 *    handling finishes inside this test.
 *
 * It reaches private members, so it checks each one first: a rename must fail
 * here, loudly, instead of turning the teardown into a silent no-op. The
 * manager is taken as `object`: src/testing may not import the
 * AgentProcessManager module (daemon-runtime-boundaries).
 */
/** The private AgentProcessManager members this teardown uses, checked at runtime by requireMembers. */
interface ManagerStartInternals {
  coldIdleSweepTimer: ReturnType<typeof setInterval> | null;
  agentStarts: unknown;
  capabilityHolds: Map<string, { cancel(): void }>;
  lifecycleRecords: unknown;
  runtimeErrorProcessRestartTimers: Map<string, ReturnType<typeof setTimeout>>;
  startAgentNow: () => Promise<void>;
  ensureManagedRunnerCredential: () => Promise<never>;
}

interface StartCoordinatorInternals {
  cancelAllQueued(): Array<{ resolve(): void }>;
  snapshot(): { activeStarts: number };
}

export async function drainAgentManagerForTests(
  manager: object,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const m = requireMembers<ManagerStartInternals>("AgentProcessManager", manager, {
    coldIdleSweepTimer: "field",
    agentStarts: "object",
    capabilityHolds: "object",
    lifecycleRecords: "object",
    runtimeErrorProcessRestartTimers: "object",
    startAgentNow: "function",
    ensureManagedRunnerCredential: "function",
  });
  const agentStarts = requireMembers<StartCoordinatorInternals>("agentStarts", m.agentStarts, { cancelAllQueued: "function", snapshot: "function" });
  const lifecycleRecords = requireMembers<{
    clearRestartSnapshots(): void;
    activeSpawnFailBackoffs: Map<string, { timer?: ReturnType<typeof setTimeout> | null }>;
  }>("lifecycleRecords", m.lifecycleRecords, { clearRestartSnapshots: "function", activeSpawnFailBackoffs: "object" });

  if (m.coldIdleSweepTimer) clearInterval(m.coldIdleSweepTimer);
  m.coldIdleSweepTimer = null;
  // The coordinator directly, not cancelAllQueuedAgentStarts: that also asserts
  // residency invariants, and a teardown must not fail on the state a test
  // deliberately left behind.
  for (const item of agentStarts.cancelAllQueued()) item.resolve();
  for (const wait of [...m.capabilityHolds.values()]) wait.cancel();
  lifecycleRecords.clearRestartSnapshots();
  // Mirror stopAll (task #357): with the restart configs gone, a still-active
  // spawn-fail cooldown would trip the residency invariant in the stopAll
  // that follows this drain.
  for (const state of lifecycleRecords.activeSpawnFailBackoffs.values()) {
    if (state.timer) clearTimeout(state.timer);
  }
  lifecycleRecords.activeSpawnFailBackoffs.clear();
  for (const timer of m.runtimeErrorProcessRestartTimers.values()) clearTimeout(timer);
  m.runtimeErrorProcessRestartTimers.clear();

  m.startAgentNow = async () => {};
  m.ensureManagedRunnerCredential = async () => {
    throw new Error("agent manager torn down: no runner credential mint after the test ended");
  };

  // Under fake timers nothing in flight advances on its own; the fence is enough.
  if (vi.isFakeTimers()) return;
  const deadline = Date.now() + (options.timeoutMs ?? 2_000);
  while (agentStarts.snapshot().activeStarts > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

type MemberKind = "field" | "object" | "function";

/** Fail with the member's name when a private member this teardown relies on is gone. */
export function requireMembers<T>(owner: string, target: unknown, members: Record<string, MemberKind>): T {
  const record = target as Record<string, unknown>;
  for (const [name, kind] of Object.entries(members)) {
    const value = record?.[name];
    const present = kind === "field"
      ? record !== null && typeof record === "object" && name in record
      : kind === "function" ? typeof value === "function" : typeof value === "object" && value !== null;
    if (!present) {
      throw new Error(`drainAgentManagerForTests: ${owner} has no ${kind} \`${name}\`; update the teardown`);
    }
  }
  return target as T;
}

type Timer = ReturnType<typeof setTimeout>;

/** The per-process timer state releaseAgentManagerForTests clears, checked at runtime by requireMembers. */
interface ProcessTimerInternals {
  notifications: { clearTimer(): void };
  startup: { kind: string; timer?: Timer | null };
  activityHeartbeat: { kind: string; timer?: ReturnType<typeof setInterval> };
  pendingTrajectory: { timer?: Timer | null } | null;
  compaction: { kind: string; watchdog?: Timer | null };
  exit: { kind: string };
  runtimeErrorDeliveryBackoff: { kind: string; timer?: Timer | null };
  sessionReadyDeliveryRetry: { kind: string; scheduler?: { clearTimer(): void } };
}

/**
 * Full teardown for a test's AgentProcessManager: drain and fence start work
 * (drainAgentManagerForTests), then clear every per-process timer, forget
 * the processes and reset the process-global session-ready retry scheduler
 * factory. Call it before restoring the test's fetch mocks and before
 * removing the data directory.
 */
export async function releaseAgentManagerForTests(
  manager: object,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  await drainAgentManagerForTests(manager, options);
  const m = requireMembers<{ agents: Map<string, unknown> }>("AgentProcessManager", manager, { agents: "object" });
  for (const entry of m.agents.values()) {
    const ap = requireMembers<ProcessTimerInternals>("AgentProcess", entry, {
      notifications: "object",
      startup: "field",
      activityHeartbeat: "field",
      pendingTrajectory: "field",
      compaction: "field",
      exit: "field",
      runtimeErrorDeliveryBackoff: "field",
      sessionReadyDeliveryRetry: "field",
    });
    ap.notifications.clearTimer();
    if (ap.startup.kind === "waiting" && ap.startup.timer) clearTimeout(ap.startup.timer);
    if (ap.activityHeartbeat.kind === "active") clearInterval(ap.activityHeartbeat.timer);
    if (ap.pendingTrajectory?.timer) clearTimeout(ap.pendingTrajectory.timer);
    if (ap.compaction.kind === "active" && ap.compaction.watchdog) clearTimeout(ap.compaction.watchdog);
    if (ap.runtimeErrorDeliveryBackoff.kind === "backing_off" && ap.runtimeErrorDeliveryBackoff.timer) {
      clearTimeout(ap.runtimeErrorDeliveryBackoff.timer);
    }
    if (ap.sessionReadyDeliveryRetry.kind === "scheduled") ap.sessionReadyDeliveryRetry.scheduler?.clearTimer();
  }
  m.agents.clear();
  // withManager may install a custom session-ready retry scheduler factory; it
  // is process-global, so a later test outside withManager would inherit it.
  setSessionReadyDeliveryRetrySchedulerFactoryForTesting(null);
}
